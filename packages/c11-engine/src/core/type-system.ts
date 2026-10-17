import { failure } from './internal.ts';
import type {
  AggregateDefinition, CType, FunctionCType, Location, PointerCType, ArrayCType,
  AggregateCType, TypeQualifiers,
} from './internal.ts';

export const pointerTo = (base: CType, qualifiers: { const?: boolean; volatile?: boolean; restrict?: boolean; baseConst?: boolean; baseVolatile?: boolean } = {}): PointerCType =>
  Object.freeze({ kind: 'pointer', base, ...qualifiers });
export const arrayOf = (element: CType, length: number | null): ArrayCType => Object.freeze({ kind: 'array', element, length });
export const functionOf = (returnType: CType, parameters: readonly CType[], variadic = false, prototype = true): FunctionCType =>
  Object.freeze({ kind: 'function', returnType, parameters: Object.freeze([...parameters]), ...(variadic ? { variadic: true } : {}), prototype });
export const aggregateRef = (id: number): AggregateCType => Object.freeze({ kind: 'aggregate', id });

export function unqualifiedType(type: CType): CType {
  while (typeof type !== 'string' && type.kind === 'qualified') type = type.base;
  return type;
}

export function qualifiersOf(type: CType): TypeQualifiers {
  const qualifiers: { const?: boolean; volatile?: boolean; restrict?: boolean } = {};
  while (typeof type !== 'string' && type.kind === 'qualified') {
    qualifiers.const ||= type.qualifiers.const;
    qualifiers.volatile ||= type.qualifiers.volatile;
    qualifiers.restrict ||= type.qualifiers.restrict;
    type = type.base;
  }
  if (typeof type !== 'string' && type.kind === 'pointer') {
    qualifiers.const ||= type.const;
    qualifiers.volatile ||= type.volatile;
    qualifiers.restrict ||= type.restrict;
  }
  return qualifiers;
}

export function qualifyType(type: CType, qualifiers: TypeQualifiers): CType {
  const next = {
    ...(qualifiersOf(type).const || qualifiers.const ? { const: true } : {}),
    ...(qualifiersOf(type).volatile || qualifiers.volatile ? { volatile: true } : {}),
    ...(qualifiersOf(type).restrict || qualifiers.restrict ? { restrict: true } : {}),
  };
  if (!next.const && !next.volatile && !next.restrict) return type;
  const base = unqualifiedType(type);
  // C applies array qualifiers to its element type.
  if (typeof base !== 'string' && base.kind === 'array') {
    return arrayOf(qualifyType(base.element, next), base.length);
  }
  return Object.freeze({ kind: 'qualified', base, qualifiers: Object.freeze(next) });
}

export function pointerType(type: CType): PointerCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'pointer' ? unqualified : undefined;
}
export function arrayType(type: CType): ArrayCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'array' ? unqualified : undefined;
}
export function aggregateType(type: CType): AggregateCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'aggregate' ? unqualified : undefined;
}
export function functionType(type: CType): FunctionCType | undefined {
  const unqualified = unqualifiedType(type);
  return typeof unqualified !== 'string' && unqualified.kind === 'function' ? unqualified : undefined;
}

/** Resolve a pointer's designated type, including legacy baseConst/baseVolatile metadata. */
export function pointedToType(type: CType): CType | undefined {
  const pointer = pointerType(type);
  if (!pointer) return undefined;
  return qualifyType(pointer.base, {
    ...(pointer.baseConst ? { const: true } : {}),
    ...(pointer.baseVolatile ? { volatile: true } : {}),
  });
}

// These are semantic predicates, not TypeScript narrowing predicates: a qualified type
// remains a QualifiedCType and must be unwrapped before accessing structural fields.
export function isPointer(type: CType): boolean { return pointerType(type) !== undefined; }
export function isArray(type: CType): boolean { return arrayType(type) !== undefined; }
export function isAggregate(type: CType): boolean { return aggregateType(type) !== undefined; }
export function isFunction(type: CType): boolean { return functionType(type) !== undefined; }

const integerTypes = new Set<CType>([
  '_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long', 'long long', 'unsigned long long',
]);
export function isInteger(type: CType): boolean { return integerTypes.has(unqualifiedType(type)); }
export function isArithmetic(type: CType): boolean {
  const unqualified = unqualifiedType(type);
  return isInteger(unqualified) || unqualified === 'float' || unqualified === 'double' || unqualified === 'long double';
}
export function isScalar(type: CType): boolean { return isArithmetic(type) || isPointer(type); }
export function isObject(type: CType): boolean { return unqualifiedType(type) !== 'void' && !isFunction(type); }

export type AggregateContext = readonly AggregateDefinition[];
export const isComplete = (type: CType, aggregates: AggregateContext): boolean => {
  type = unqualifiedType(type);
  if (type === 'void' || isFunction(type)) return false;
  if (pointerType(type)) return true;
  const array = arrayType(type);
  if (array) return array.length !== null && isComplete(array.element, aggregates);
  const aggregate = aggregateType(type);
  if (aggregate) return aggregates.some((definition) => definition.id === aggregate.id && definition.complete);
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
  if (type === 'float') return 4;
  if (type === 'double') return 8;
  if (type === 'long double') return 16;
  if (pointerType(type)) return 8;
  return typeof type === 'string' ? integerLayout[type]?.size ?? 0 : 0;
}
export function scalarAlignment(type: CType): number {
  type = unqualifiedType(type);
  if (type === 'float') return 4;
  if (type === 'double') return 8;
  if (type === 'long double') return 16;
  if (pointerType(type)) return 8;
  return typeof type === 'string' ? integerLayout[type]?.alignment ?? 0 : 0;
}
export function integerInfo(type: CType) { type = unqualifiedType(type); return typeof type === 'string' ? integerLayout[type] : undefined; }

const fallbackLocation: Location = { file: 'main.c', line: 1, column: 1 };
const layingOut = new Set<number>();

export function layoutAggregate(definition: AggregateDefinition, aggregates: AggregateContext, at: Location = definition.location): void {
  if (!definition.complete) failure('INCOMPLETE_TYPE', `El tipo ${definition.kind} ${definition.tag ?? ''} todavía está incompleto.`, at);
  if (definition.size !== undefined && definition.alignment !== undefined) return;
  if (layingOut.has(definition.id)) failure('INCOMPLETE_TYPE', 'Un agregado no puede contenerse directamente a sí mismo por valor.', at);
  if (definition.members.length === 0) failure('TYPE_ERROR', 'Un struct o union debe declarar al menos un miembro con nombre.', at);
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
          failure('TYPE_ERROR', 'El ancho de un bit-field debe caber en su tipo entero declarado.', member.location);
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
          if (!member.unnamedBitField) failure('TYPE_ERROR', 'Un bit-field de ancho cero debe ser anónimo.', member.location);
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
          failure('TYPE_ERROR', 'Un miembro flexible debe ser un array incompleto final de un struct.', member.location);
        }
        flexibleMemberIndex = member.index;
        size = alignUp(size, memberAlignment);
        member.offset = size;
        continue;
      }

      if (containsFlexibleAggregate(member.type, aggregates)) {
        failure('TYPE_ERROR', 'Un tipo que contiene un miembro flexible no puede ser miembro de otro agregado ni de un array.', member.location);
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
  if (!definition || !definition.complete) failure('INCOMPLETE_TYPE', `El tipo agregado ${type.id} está incompleto.`, at);
  return definition;
}
export function sizeOfType(type: CType, aggregates: AggregateContext = [], at: Location = fallbackLocation): number {
  type = unqualifiedType(type);
  if (type === 'void' || isFunction(type)) failure('INCOMPLETE_TYPE', 'El tipo no tiene tamaño de objeto en C11.', at);
  if (pointerType(type)) return 8;
  const array = arrayType(type);
  if (array) {
    if (array.length === null) failure('INCOMPLETE_TYPE', 'No se puede calcular sizeof de un array incompleto.', at);
    const stride = sizeOfType(array.element, aggregates, at);
    const size = stride * array.length;
    if (!Number.isSafeInteger(size)) failure('TYPE_SIZE_RANGE', 'El tamaño del objeto excede el perfil virtual representable.', at);
    return size;
  }
  const aggregate = aggregateType(type);
  if (aggregate) {
    const definition = aggregateDefinition(aggregate, aggregates, at);
    layoutAggregate(definition, aggregates, at);
    return definition.size!;
  }
  const size = scalarSize(type);
  if (!size) failure('INCOMPLETE_TYPE', `El tipo «${String(type)}» no tiene tamaño de objeto.`, at);
  return size;
}
export function alignOfType(type: CType, aggregates: AggregateContext = [], at: Location = fallbackLocation): number {
  type = unqualifiedType(type);
  if (type === 'void' || isFunction(type)) failure('INCOMPLETE_TYPE', 'El tipo no tiene alineación de objeto en C11.', at);
  if (pointerType(type)) return 8;
  const array = arrayType(type);
  if (array) return alignOfType(array.element, aggregates, at);
  const aggregate = aggregateType(type);
  if (aggregate) {
    const definition = aggregateDefinition(aggregate, aggregates, at);
    layoutAggregate(definition, aggregates, at);
    return definition.alignment!;
  }
  const alignment = scalarAlignment(type);
  if (!alignment) failure('INCOMPLETE_TYPE', `El tipo «${String(type)}» no tiene alineación de objeto.`, at);
  return alignment;
}

export function decayType(type: CType): CType {
  const array = arrayType(type);
  if (array) return pointerTo(array.element);
  const fn = functionType(type);
  if (fn) return pointerTo(fn);
  return type;
}

function sameTypeInner(left: CType, right: CType): boolean {
  const leftQualifiers = qualifiersOf(left), rightQualifiers = qualifiersOf(right);
  if (!!leftQualifiers.const !== !!rightQualifiers.const || !!leftQualifiers.volatile !== !!rightQualifiers.volatile || !!leftQualifiers.restrict !== !!rightQualifiers.restrict) return false;
  left = unqualifiedType(left); right = unqualifiedType(right);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'pointer' && right.kind === 'pointer') return sameTypeInner(pointedToType(left)!, pointedToType(right)!);
  if (left.kind === 'array' && right.kind === 'array') return left.length === right.length && sameTypeInner(left.element, right.element);
  if (left.kind === 'aggregate' && right.kind === 'aggregate') return left.id === right.id;
  if (left.kind === 'function' && right.kind === 'function') {
    return left.variadic === right.variadic && left.prototype === right.prototype && left.parameters.length === right.parameters.length &&
      sameTypeInner(left.returnType, right.returnType) && left.parameters.every((parameter, index) => sameTypeInner(parameter, right.parameters[index]));
  }
  return false;
}
export function sameType(left: CType, right: CType): boolean { return sameTypeInner(left, right); }

export function compatibleType(left: CType, right: CType): boolean {
  if (sameTypeInner(left, right)) return true;
  const leftQualifiers = qualifiersOf(left), rightQualifiers = qualifiersOf(right);
  if (!!leftQualifiers.const !== !!rightQualifiers.const || !!leftQualifiers.volatile !== !!rightQualifiers.volatile || !!leftQualifiers.restrict !== !!rightQualifiers.restrict) return false;
  left = unqualifiedType(left); right = unqualifiedType(right);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  const leftArray = arrayType(left), rightArray = arrayType(right);
  if (leftArray && rightArray) return sameTypeInner(leftArray.element, rightArray.element) && (leftArray.length === null || rightArray.length === null || leftArray.length === rightArray.length);
  if (pointerType(left) && pointerType(right)) {
    return compatibleType(pointedToType(left)!, pointedToType(right)!);
  }
  const leftFunction = functionType(left), rightFunction = functionType(right);
  if (leftFunction && rightFunction) {
    if (!compatibleType(leftFunction.returnType, rightFunction.returnType)) return false;
    const leftHasPrototype = leftFunction.prototype !== false;
    const rightHasPrototype = rightFunction.prototype !== false;
    if (leftHasPrototype && rightHasPrototype) {
      return leftFunction.variadic === rightFunction.variadic && leftFunction.parameters.length === rightFunction.parameters.length &&
        leftFunction.parameters.every((parameter, index) => compatibleParameterType(parameter, rightFunction.parameters[index]));
    }
    if (!leftHasPrototype && !rightHasPrototype) return true;
    const prototype = leftHasPrototype ? leftFunction : rightFunction;
    if (prototype.variadic) return false;
    return prototype.parameters.every((parameter) => compatibleAfterDefaultPromotion(parameter));
  }
  return false;
}

function compatibleParameterType(left: CType, right: CType): boolean {
  return compatibleType(unqualifiedType(left), unqualifiedType(right));
}

function compatibleAfterDefaultPromotion(type: CType): boolean {
  type = unqualifiedType(type);
  if (type === 'float') return false;
  if (isInteger(type)) {
    const info = integerInfo(type)!;
    return info.rank >= integerInfo('int')!.rank || type === 'unsigned int';
  }
  return true;
}

export function compositeType(left: CType, right: CType): CType | undefined {
  if (sameTypeInner(left, right)) return left;
  const qualifiers = qualifiersOf(left);
  const rightQualifiers = qualifiersOf(right);
  const combinedQualifiers = {
    ...(qualifiers.const || rightQualifiers.const ? { const: true } : {}),
    ...(qualifiers.volatile || rightQualifiers.volatile ? { volatile: true } : {}),
    ...(qualifiers.restrict || rightQualifiers.restrict ? { restrict: true } : {}),
  };
  left = unqualifiedType(left); right = unqualifiedType(right);
  const leftArray = arrayType(left), rightArray = arrayType(right);
  if (leftArray && rightArray && sameTypeInner(leftArray.element, rightArray.element)) {
    return qualifyType(arrayOf(leftArray.element, leftArray.length ?? rightArray.length), combinedQualifiers);
  }
  const leftPointer = pointerType(left), rightPointer = pointerType(right);
  if (leftPointer && rightPointer) {
    const leftBase = pointedToType(left)!;
    const rightBase = pointedToType(right)!;
    if (compatibleType(leftBase, rightBase)) return qualifyType(pointerTo(compositeType(leftBase, rightBase) ?? leftBase), combinedQualifiers);
    if (unqualifiedType(leftBase) === 'void' && isObject(rightBase)) return qualifyType(pointerTo(qualifyType('void', { const: !!qualifiersOf(leftBase).const || !!qualifiersOf(rightBase).const, volatile: !!qualifiersOf(leftBase).volatile || !!qualifiersOf(rightBase).volatile })), combinedQualifiers);
    if (unqualifiedType(rightBase) === 'void' && isObject(leftBase)) return qualifyType(pointerTo(qualifyType('void', { const: !!qualifiersOf(leftBase).const || !!qualifiersOf(rightBase).const, volatile: !!qualifiersOf(leftBase).volatile || !!qualifiersOf(rightBase).volatile })), combinedQualifiers);
  }
  const leftFunction = functionType(left), rightFunction = functionType(right);
  if (compatibleType(left, right) && leftFunction && rightFunction) {
    const preferred = leftFunction.prototype === false ? rightFunction : leftFunction;
    return functionOf(preferred.returnType, preferred.parameters, !!preferred.variadic, preferred.prototype !== false);
  }
  return undefined;
}

/** C's implicit void-pointer conversion applies only to object pointers. */
export function canConvertPointerType(from: CType, to: CType): boolean {
  if (!pointerType(from) || !pointerType(to)) return false;
  const fromBase = pointedToType(from)!;
  const toBase = pointedToType(to)!;
  const fromQualifiers = qualifiersOf(fromBase), toQualifiers = qualifiersOf(toBase);
  if ((fromQualifiers.const && !toQualifiers.const) || (fromQualifiers.volatile && !toQualifiers.volatile) || (fromQualifiers.restrict && !toQualifiers.restrict)) return false;
  const sameAfterTopQualification = compatibleType(unqualifiedType(fromBase), unqualifiedType(toBase));
  if (sameAfterTopQualification) return true;
  return unqualifiedType(fromBase) === 'void' && isObject(toBase) ||
    unqualifiedType(toBase) === 'void' && isObject(fromBase);
}

export function typeName(type: CType, aggregates: AggregateContext = []): string {
  const qualifiers = qualifiersOf(type);
  const base = unqualifiedType(type);
  if (qualifiers.const || qualifiers.volatile || qualifiers.restrict) {
    const suffix = [qualifiers.const ? 'const' : '', qualifiers.volatile ? 'volatile' : '', qualifiers.restrict ? 'restrict' : ''].filter(Boolean).join(' ');
    if (pointerType(base)) return `${typeName(base, aggregates)} ${suffix}`;
    return `${suffix} ${typeName(base, aggregates)}`;
  }
  type = base;
  if (typeof type === 'string') return type;
  const pointer = pointerType(type);
  if (pointer) return `${typeName(pointedToType(pointer)!, aggregates)} *`;
  const array = arrayType(type);
  if (array) return `${typeName(array.element, aggregates)}[${array.length ?? ''}]`;
  const fn = functionType(type);
  if (fn) return `${typeName(fn.returnType, aggregates)} (${fn.prototype === false ? '' : fn.parameters.map((item) => typeName(item, aggregates)).join(', ')}${fn.variadic ? `${fn.parameters.length ? ', ' : ''}...` : ''})`;
  const aggregate = aggregateType(type)!;
  const definition = aggregates.find((item) => item.id === aggregate.id);
  return `${definition?.kind ?? 'aggregate'}${definition?.tag ? ` ${definition.tag}` : `#${aggregate.id}`}`;
}
