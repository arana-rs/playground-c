import { MemorySnapshots } from './snapshots.ts';
import { failure } from '../internal.ts';
import type { AggregateDefinition, CType, FunctionPointerValue, Location, ObjectScalarValue } from '../internal.ts';
import { binary80Zero } from '../binary80.ts';
import { aggregateType, alignOfType, arrayOf, arrayType, compatibleType, isFunction, isPointer, isScalar, sameType, sizeOfType, unqualifiedType } from '../type-system.ts';
import { CORRESPONDING_UNSIGNED, CORRESPONDING_SIGNED, isCharacterType } from './state.ts';
import type { RuntimeObject } from './state.ts';

export abstract class MemoryEffectiveTypes extends MemorySnapshots {
  protected override ensureWritable(node: RuntimeObject, at: Location, initializing = false): void {
    if (node.duration === 'string-literal') failure('STRING_LITERAL_MODIFICATION', 'Modifying a string literal is undefined behavior in C11.', at);
    if (initializing) return;
    const root = this.rootFor(node, at);
    const field = this.bitFieldFor(node, at)?.member.bitField;
    const start = node.byteOffset;
    const end = start + node.size;
    const writeMask = field
      ? ((1n << BigInt(field.width)) - 1n) << BigInt(field.bitOffset)
      : undefined;
    if (root.constRanges.some((range) => range.start < end && start < range.end &&
      (range.bitMask === undefined || writeMask === undefined || (range.bitMask & writeMask) !== 0n))) {
      failure('CONST_OBJECT_MODIFICATION', 'Modifying an object defined with const is undefined behavior in C11.', at);
    }
  }

  protected override ensureEffectiveType(node: RuntimeObject, at: Location): void {
    const root = this.rootFor(node, at);
    if (!root.rawAllocation || node.byteView || isCharacterType(node.type)) return;
    const start = node.byteOffset;
    const end = start + node.size;
    const candidates = root.effectiveTypes
      .map((range, index) => ({ range, index }))
      .filter(({ range }) => range.start <= start && range.end >= end)
      .sort((left, right) => {
        const leftSize = left.range.end - left.range.start;
        const rightSize = right.range.end - right.range.start;
        return leftSize - rightSize || right.index - left.index;
      });
    if (candidates.some(({ range }) => this.effectiveTypeCovers(range.type, range.start, range.end, start, end, node.type, at))) return;
    if (root.effectiveTypes.some((range) => range.start < end && start < range.end)) {
      failure('EFFECTIVE_TYPE_VIOLATION', 'Access is incompatible with the effective type established in heap storage.', at);
    }
  }

  protected override effectiveTypeCovers(
    effectiveType: CType,
    effectiveStart: number,
    effectiveEnd: number,
    accessStart: number,
    accessEnd: number,
    accessType: CType,
    at: Location,
  ): boolean {
    if (accessStart === effectiveStart && accessEnd === effectiveEnd) {
      return this.typesMayAlias(effectiveType, accessType, at);
    }
    const array = arrayType(effectiveType);
    if (array) {
      const elementSize = sizeOfType(array.element, this.aggregates, at);
      const length = array.length ?? Math.floor((effectiveEnd - effectiveStart) / elementSize);
      const first = Math.max(0, Math.floor((accessStart - effectiveStart) / elementSize));
      const last = Math.min(length - 1, Math.floor((accessEnd - 1 - effectiveStart) / elementSize));
      for (let index = first; index <= last; index++) {
        const elementStart = effectiveStart + index * elementSize;
        if (accessStart >= elementStart && accessEnd <= elementStart + elementSize &&
            this.effectiveTypeCovers(array.element, elementStart, elementStart + elementSize, accessStart, accessEnd, accessType, at)) return true;
      }
      return false;
    }
    const aggregate = aggregateType(effectiveType);
    if (!aggregate) return false;
    const definition = this.aggregate(aggregate, at);
    for (const member of definition.members) {
      const memberStart = effectiveStart + member.offset;
      const memberArray = member.flexibleArray ? arrayType(member.type) : undefined;
      const memberSize = member.bitField
        ? member.bitField.storageUnitSize
        : memberArray
          ? Math.max(0, effectiveEnd - memberStart)
          : sizeOfType(member.type, this.aggregates, member.location);
      if (accessStart < memberStart || accessEnd > memberStart + memberSize) continue;
      const memberType = memberArray
        ? arrayOf(memberArray.element, Math.floor(memberSize / sizeOfType(memberArray.element, this.aggregates, member.location)))
        : member.type;
      if (this.effectiveTypeCovers(memberType, memberStart, memberStart + memberSize, accessStart, accessEnd, accessType, at)) return true;
    }
    return false;
  }

  protected override typesMayAlias(left: CType, right: CType, at: Location, visited = new Set<string>()): boolean {
    left = unqualifiedType(left);
    right = unqualifiedType(right);
    if (sameType(left, right)) return true;
    if (compatibleType(left, right)) return true;
    if (isCharacterType(right)) return true;
    const leftName = typeof left === 'string' ? left : undefined;
    const rightName = typeof right === 'string' ? right : undefined;
    if (leftName && rightName &&
        (CORRESPONDING_UNSIGNED[leftName] === rightName || CORRESPONDING_SIGNED[leftName] === rightName)) return true;
    const key = `${this.typeKey(left)}:${this.typeKey(right)}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return this.aggregateContainsType(left, right, at, visited) || this.aggregateContainsType(right, left, at, visited);
  }

  protected override aggregateContainsType(container: CType, target: CType, at: Location, visited: Set<string>): boolean {
    const array = arrayType(container);
    if (array) return this.typesMayAlias(array.element, target, at, visited);
    const aggregate = aggregateType(container);
    if (!aggregate) return false;
    const definition = this.aggregate(aggregate, at);
    return definition.members.some((member) => this.typesMayAlias(member.type, target, at, visited));
  }

  protected override recordEffectiveType(node: RuntimeObject, type: CType, at: Location): void {
    const root = this.rootFor(node, at);
    if (!root.rawAllocation || node.byteView) return;
    const start = node.byteOffset;
    const end = start + node.size;
    const storedType = unqualifiedType(type);
    if (isCharacterType(storedType)) return;
    root.effectiveTypes.splice(0, root.effectiveTypes.length,
      ...root.effectiveTypes.filter((range) => range.start !== start || range.end !== end));
    root.effectiveTypes.push({ start, end, type: storedType, initialization: this.copyInitializationSnapshot(node, at) });
  }

  protected override aggregate(type: CType, at: Location): AggregateDefinition {
    const aggregate = aggregateType(type);
    const definition = aggregate && this.aggregates.find((item) => item.id === aggregate.id);
    if (!definition?.complete) failure('INCOMPLETE_TYPE', `Aggregate type ${aggregate?.id ?? '?'} is incomplete.`, at);
    return definition;
  }

  protected override alignment(type: CType, at: Location): number {
    // Alignment is the stride divisor for valid typed pointer accesses.
    return alignOfType(type, this.aggregates, at);
  }

  protected override zeroValue(type: CType, at: Location): ObjectScalarValue {
    if (isPointer(type)) return null;
    if (type === 'long double') return binary80Zero();
    if (isScalar(type)) return type === 'float' || type === 'double' ? 0 : 0n;
    if (isFunction(type)) return { kind: 'function-pointer', functionIndex: null } satisfies FunctionPointerValue;
    failure('INVALID_ZERO_INITIALIZER', 'The type does not allow scalar zero initialization.', at);
  }
}
