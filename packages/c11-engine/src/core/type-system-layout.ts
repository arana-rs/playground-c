import { failure } from './internal.ts';
import type { AggregateCType, AggregateDefinition, CType, Location } from './internal.ts';
import { aggregateType, arrayType, enumType, isArray, isFunction, isObject, pointerType, qualifiersOf, unqualifiedType } from './type-system-core.ts';
import type { AggregateContext } from './type-system-context.ts';

export const isComplete = (type: CType, aggregates: AggregateContext): boolean => {
  type = unqualifiedType(type);
  if (type === 'void' || isFunction(type)) return false;
  if (pointerType(type)) return true;
  const array = arrayType(type);
  if (array) return (array.length !== null || array.lengthExpression !== undefined) && isComplete(array.element, aggregates);
  const aggregate = aggregateType(type);
  if (aggregate) return aggregates.some((definition) => definition.id === aggregate.id && definition.complete);
  const enumeration = enumType(type);
  if (enumeration) return enumeration.definition.complete;
  return true;
};
export function isModifiableObject(type: CType, aggregates: AggregateContext): boolean {
  if (!isObject(type) || isArray(type) || qualifiersOf(type).const || !isComplete(type, aggregates)) return false;
  const aggregate = aggregateType(type);
  if (!aggregate) return true;
  const definition = aggregates.find((item) => item.id === aggregate.id);
  return !!definition && definition.members.every((member) => !containsConstSubobject(member.type, aggregates));
}

function containsConstSubobject(type: CType, aggregates: AggregateContext, seen = new Set<number>()): boolean {
  if (qualifiersOf(type).const) return true;
  const base = unqualifiedType(type);
  if (typeof base === 'string' || base.kind === 'pointer' || base.kind === 'function') return false;
  if (base.kind === 'array') return containsConstSubobject(base.element, aggregates, seen);
  const aggregate = aggregateType(base);
  if (!aggregate || seen.has(aggregate.id)) return false;
  seen.add(aggregate.id);
  const definition = aggregates.find((item) => item.id === aggregate.id);
  return !!definition?.members.some((member) => containsConstSubobject(member.type, aggregates, seen));
}

const integerLayout: Record<string, { size: number; alignment: number; bits: number; rank: number; unsigned: boolean }> = {
  _Bool: { size: 1, alignment: 1, bits: 8, rank: 0, unsigned: true },
  char: { size: 1, alignment: 1, bits: 8, rank: 1, unsigned: false },
  'signed char': { size: 1, alignment: 1, bits: 8, rank: 1, unsigned: false },
  'unsigned char': { size: 1, alignment: 1, bits: 8, rank: 1, unsigned: true },
  short: { size: 2, alignment: 2, bits: 16, rank: 2, unsigned: false },
  'unsigned short': { size: 2, alignment: 2, bits: 16, rank: 2, unsigned: true },
  int: { size: 4, alignment: 4, bits: 32, rank: 3, unsigned: false },
  'unsigned int': { size: 4, alignment: 4, bits: 32, rank: 3, unsigned: true },
  long: { size: 8, alignment: 8, bits: 64, rank: 4, unsigned: false },
  'unsigned long': { size: 8, alignment: 8, bits: 64, rank: 4, unsigned: true },
  'long long': { size: 8, alignment: 8, bits: 64, rank: 5, unsigned: false },
  'unsigned long long': { size: 8, alignment: 8, bits: 64, rank: 5, unsigned: true },
};

export function scalarSize(type: CType): number {
  type = unqualifiedType(type);
  const enumeration = enumType(type);
  if (enumeration) return integerLayout[enumeration.integerType].size;
  if (type === 'float') return 4;
  if (type === 'double') return 8;
  if (type === 'long double') return 16;
  if (pointerType(type)) return 8;
  return typeof type === 'string' ? integerLayout[type]?.size ?? 0 : 0;
}
export function scalarAlignment(type: CType): number {
  type = unqualifiedType(type);
  const enumeration = enumType(type);
  if (enumeration) return integerLayout[enumeration.integerType].alignment;
  if (type === 'float') return 4;
  if (type === 'double') return 8;
  if (type === 'long double') return 16;
  if (pointerType(type)) return 8;
  return typeof type === 'string' ? integerLayout[type]?.alignment ?? 0 : 0;
}
export function integerInfo(type: CType) {
  const enumeration = enumType(type);
  if (enumeration) return integerLayout[enumeration.integerType];
  type = unqualifiedType(type);
  return typeof type === 'string' ? integerLayout[type] : undefined;
}

const fallbackLocation: Location = { file: 'main.c', line: 1, column: 1 };
const layingOut = new Set<number>();

export function layoutAggregate(definition: AggregateDefinition, aggregates: AggregateContext, at: Location = definition.location): void {
  if (!definition.complete) failure('INCOMPLETE_TYPE', `Type ${definition.kind} ${definition.tag ?? ''} is still incomplete.`, at);
  if (definition.size !== undefined && definition.alignment !== undefined) return;
  if (layingOut.has(definition.id)) failure('INCOMPLETE_TYPE', 'An aggregate cannot directly contain itself by value.', at);
  if (definition.members.length === 0) failure('TYPE_ERROR', 'A struct or union must declare at least one named member.', at);
  layingOut.add(definition.id);
  try {
    let size = 0;
    let alignment = 1;
    // SysV AMD64 allocates adjacent bit-fields in one bit stream. A field may
    // begin in the unused high bits of the allocation unit containing an
    // earlier ordinary member (char + unsigned b:1 => byte 1, not byte 4).
    let openUnit: { offset: number; size: number; bitsUsed: number } | undefined;
    let flexibleMemberIndex: number | undefined;
    for (const member of definition.members) {
      const memberArray = member.flexibleArray ? arrayType(member.type) : undefined;
      const naturalAlignment = memberArray
        ? alignOfType(memberArray.element, aggregates, member.location)
        : member.bitField
          ? alignOfType(unqualifiedType(member.type), aggregates, member.location)
          : alignOfType(member.type, aggregates, member.location);
      const isZeroWidthBitField = !!member.bitField && member.bitField.width === 0;
      // On this profile an unnamed zero-width field is a byte-layout barrier,
      // but does not raise the aggregate's natural alignment.
      const memberAlignment = isZeroWidthBitField ? 1 : Math.max(naturalAlignment, member.requestedAlignment ?? member.alignment ?? 1);
      member.alignment = memberAlignment;
      alignment = Math.max(alignment, memberAlignment);

      if (member.bitField) {
        const bits = member.bitField;
        const declaredType = unqualifiedType(member.type);
        const unitSize = sizeOfType(declaredType, aggregates, member.location);
        const info = integerInfo(member.type);
        if (!info || bits.width < 0 || bits.width > info.bits || bits.width > unitSize * 8 || unqualifiedType(member.type) === '_Bool' && bits.width > 1) {
          failure('TYPE_ERROR', 'A bit-field width must fit in its declared integer type.', member.location);
        }
        bits.storageUnitSize = unitSize;
        bits.signed = !info.unsigned;
        if (definition.kind === 'union') {
          bits.storageUnitOffset = 0;
          bits.bitOffset = 0;
          member.offset = 0;
          if (bits.width > 0) size = Math.max(size, unitSize);
          openUnit = undefined;
          continue;
        }
        if (bits.width === 0) {
          if (!member.unnamedBitField) failure('TYPE_ERROR', 'A zero-width bit-field must be unnamed.', member.location);
          openUnit = undefined;
          size = alignUp(size, unitSize);
          bits.storageUnitOffset = size;
          bits.bitOffset = 0;
          member.offset = size;
          continue;
        }
        const capacity = unitSize * 8;
        if (definition.kind === 'struct') {
          if (openUnit && openUnit.bitsUsed + bits.width <= Math.max(openUnit.size, unitSize) * 8) {
            openUnit.size = Math.max(openUnit.size, unitSize);
          } else {
            const containingUnit = Math.floor(size / unitSize) * unitSize;
            const usedBits = Math.max(0, size * 8 - containingUnit * 8);
            if (usedBits + bits.width <= capacity) {
              openUnit = { offset: containingUnit, size: unitSize, bitsUsed: usedBits };
            } else {
              const offset = alignUp(size, unitSize);
              openUnit = { offset, size: unitSize, bitsUsed: 0 };
            }
          }
          bits.storageUnitOffset = openUnit.offset;
          bits.bitOffset = openUnit.bitsUsed;
          member.offset = openUnit.offset;
          openUnit.bitsUsed += bits.width;
          size = Math.max(size, Math.ceil((openUnit.offset * 8 + openUnit.bitsUsed) / 8));
          continue;
        }
        const offset = 0;
        bits.storageUnitOffset = offset;
        bits.bitOffset = 0;
        member.offset = offset;
        size = Math.max(size, unitSize);
        continue;
      }

      openUnit = undefined;
      if (member.flexibleArray) {
        const flexibleType = arrayType(member.type);
        if (definition.kind !== 'struct' || !flexibleType || flexibleType.length !== null || flexibleMemberIndex !== undefined ||
            member.index !== definition.members.length - 1 ||
            !definition.members.slice(0, member.index).some((prior) => !!prior.name)) {
          failure('TYPE_ERROR', 'A flexible member must be the final incomplete array in a struct.', member.location);
        }
        flexibleMemberIndex = member.index;
        size = alignUp(size, memberAlignment);
        member.offset = size;
        continue;
      }

      if (containsFlexibleAggregate(member.type, aggregates)) {
        failure('TYPE_ERROR', 'A type containing a flexible member cannot be a member of another aggregate or an array.', member.location);
      }

      const memberSize = sizeOfType(member.type, aggregates, member.location);
      if (definition.kind === 'union') {
        member.offset = 0;
        size = Math.max(size, memberSize);
      } else {
        size = alignUp(size, memberAlignment);
        member.offset = size;
        size += memberSize;
      }
    }
    definition.size = alignUp(size, alignment);
    definition.alignment = alignment;
    if (flexibleMemberIndex !== undefined) {
      definition.flexibleMemberIndex = flexibleMemberIndex;
      definition.flexibleOffset = definition.members[flexibleMemberIndex].offset;
    }
  } finally { layingOut.delete(definition.id); }
}

/** True when an object type embeds a struct with a flexible member by value. */
export function containsFlexibleAggregate(type: CType, aggregates: AggregateContext, seen = new Set<number>()): boolean {
  type = unqualifiedType(type);
  const array = arrayType(type);
  if (array) return containsFlexibleAggregate(array.element, aggregates, seen);
  const aggregate = aggregateType(type);
  if (!aggregate || seen.has(aggregate.id)) return false;
  seen.add(aggregate.id);
  const definition = aggregates.find((item) => item.id === aggregate.id);
  return !!definition && (definition.flexibleMemberIndex !== undefined || definition.members.some((member) => containsFlexibleAggregate(member.type, aggregates, seen)));
}

const alignUp = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;
function aggregateDefinition(type: AggregateCType, aggregates: AggregateContext, at: Location): AggregateDefinition {
  const definition = aggregates.find((item) => item.id === type.id);
  if (!definition || !definition.complete) failure('INCOMPLETE_TYPE', `Aggregate type ${type.id} is incomplete.`, at);
  return definition;
}
export function sizeOfType(type: CType, aggregates: AggregateContext = [], at: Location = fallbackLocation): number {
  type = unqualifiedType(type);
  if (type === 'void' || isFunction(type)) failure('INCOMPLETE_TYPE', 'The type has no object size in C11.', at);
  if (pointerType(type)) return 8;
  const enumeration = enumType(type);
  if (enumeration && !enumeration.definition.complete) failure('INCOMPLETE_TYPE', 'The enum type is still incomplete.', at);
  const array = arrayType(type);
  if (array) {
    if (array.length === null) {
      if (array.lengthExpression) failure('UNRESOLVED_VLA_SIZE', 'Cannot compute sizeof for a variable-length array before its bound is evaluated.', at);
      failure('INCOMPLETE_TYPE', 'Cannot compute sizeof for an incomplete array.', at);
    }
    const stride = sizeOfType(array.element, aggregates, at);
    const size = stride * array.length;
    if (!Number.isSafeInteger(size)) failure('TYPE_SIZE_RANGE', 'The object size exceeds the representable virtual profile.', at);
    return size;
  }
  const aggregate = aggregateType(type);
  if (aggregate) {
    const definition = aggregateDefinition(aggregate, aggregates, at);
    layoutAggregate(definition, aggregates, at);
    return definition.size!;
  }
  const size = scalarSize(type);
  if (!size) failure('INCOMPLETE_TYPE', `Type «${String(type)}» has no object size.`, at);
  return size;
}
export function alignOfType(type: CType, aggregates: AggregateContext = [], at: Location = fallbackLocation): number {
  type = unqualifiedType(type);
  if (type === 'void' || isFunction(type)) failure('INCOMPLETE_TYPE', 'The type has no object alignment in C11.', at);
  if (pointerType(type)) return 8;
  const enumeration = enumType(type);
  if (enumeration && !enumeration.definition.complete) failure('INCOMPLETE_TYPE', 'The enum type is still incomplete.', at);
  const array = arrayType(type);
  if (array) return alignOfType(array.element, aggregates, at);
  const aggregate = aggregateType(type);
  if (aggregate) {
    const definition = aggregateDefinition(aggregate, aggregates, at);
    layoutAggregate(definition, aggregates, at);
    return definition.alignment!;
  }
  const alignment = scalarAlignment(type);
  if (!alignment) failure('INCOMPLETE_TYPE', `Type «${String(type)}» has no object alignment.`, at);
  return alignment;
}
