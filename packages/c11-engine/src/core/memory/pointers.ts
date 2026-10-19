import { isCharacterType, scalarOrAggregateSize } from './state.ts';
import { MemoryObjectTree } from './object-tree.ts';
import { failure } from '../internal.ts';
import type { CType, CValue, Location, ObjectPointerValue, ObjectReference } from '../internal.ts';
import { aggregateType, arrayType, compatibleType, isFunction, isPointer, pointerTo, pointedToType, pointerType, sameType, sizeOfType, unqualifiedType } from '../type-system.ts';

export abstract class MemoryPointerOperations extends MemoryObjectTree {
  override dereference(pointer: CValue, at: Location): ObjectReference {
    const targetType = pointedToType(pointer.type);
    if (!targetType) failure('INVALID_POINTER_ACCESS', 'Dereference requires a pointer.', at);
    const targetBase = unqualifiedType(targetType);
    if (targetBase === 'void' || isFunction(targetBase)) failure('INVALID_POINTER_ACCESS', 'The pointer does not designate a complete object.', at);
    if (pointer.value === null) failure('NULL_DEREFERENCE', 'Cannot dereference a null pointer.', at);
    const address = pointer.value as ObjectPointerValue;
    if (!address || address.kind !== 'object-pointer') failure('INVALID_POINTER_ACCESS', 'The value is not an object address.', at);
    const root = this.roots.get(address.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const size = sizeOfType(targetType, this.aggregates, at);
    const end = address.byteOffset + size;
    if (address.byteOffset < address.boundsStart || address.byteOffset >= address.boundsEnd || end > address.boundsEnd) {
      failure('POINTER_BOUNDS', 'Access is outside the pointed-to object or uses a one-past pointer.', at);
    }
    const alignment = this.alignment(targetType, at);
    if ((root.virtualBase + BigInt(address.byteOffset)) % BigInt(alignment) !== 0n) failure('MISALIGNED_POINTER', 'The pointer does not meet the alignment of the pointed-to type.', at);
    const target = this.locate(root, address.byteOffset, targetType, at);
    return this.reference(target, {
      arrayId: address.arrayId,
      boundsStart: address.boundsStart,
      boundsEnd: address.boundsEnd,
      arrayIndex: this.arrayIndex(address),
    });
  }

  override addressOf(ref: ObjectReference, pointerCType?: Extract<CType, { kind: 'pointer' }>): CValue {
    const node = this.nodeFor(ref, { file: 'main.c', line: 1, column: 1 });
    const targetType: CType = pointerCType ?? { kind: 'pointer', base: node.type };
    const pointer = pointerType(targetType);
    const pointedType = pointer ? pointedToType(targetType) : undefined;
    if (!pointer || !pointedType || !compatibleType(unqualifiedType(pointedType), unqualifiedType(node.type))) {
      failure('TYPE_ERROR', 'The pointer type does not match the addressed object.', { file: 'main.c', line: 1, column: 1 });
    }
    const size = node.size;
    const boundsStart = ref.arrayId !== undefined ? ref.boundsStart ?? node.byteOffset : node.byteOffset;
    const boundsEnd = ref.arrayId !== undefined ? ref.boundsEnd ?? node.byteOffset + size : node.byteOffset + size;
    const arrayId = ref.arrayId ?? node.id;
    const value: ObjectPointerValue = {
      kind: 'object-pointer', allocationId: node.allocationId, arrayId,
      byteOffset: node.byteOffset, boundsStart, boundsEnd,
    };
    return { type: targetType, value };
  }

  override decay(ref: ObjectReference): CValue {
    const node = this.nodeFor(ref, { file: 'main.c', line: 1, column: 1 });
    const array = arrayType(node.type);
    if (!array) failure('INVALID_ARRAY_DECAY', 'Array-to-pointer conversion requires an array.', { file: 'main.c', line: 1, column: 1 });
    return {
      type: { kind: 'pointer', base: array.element },
      value: {
        kind: 'object-pointer', allocationId: node.allocationId, arrayId: node.id,
        byteOffset: node.byteOffset, boundsStart: node.byteOffset, boundsEnd: node.byteOffset + node.size,
      },
    };
  }

  override pointerAdd(pointer: CValue, count: bigint, at: Location): CValue {
    const targetType = pointedToType(pointer.type);
    if (!targetType || unqualifiedType(targetType) === 'void' || isFunction(targetType) || !pointer.value) {
      failure('INVALID_POINTER_ARITHMETIC', 'Pointer arithmetic requires a non-null pointer to a complete object type.', at);
    }
    if (typeof pointer.value !== 'object' || pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_ARITHMETIC', 'Pointer arithmetic requires an object pointer.', at);
    this.assertAlive(pointer, at);
    const address = pointer.value;
    const stride = sizeOfType(targetType, this.aggregates, at);
    const offset = BigInt(address.byteOffset) + count * BigInt(stride);
    if (offset < BigInt(address.boundsStart) || offset > BigInt(address.boundsEnd) || (offset - BigInt(address.boundsStart)) % BigInt(stride) !== 0n) {
      failure('POINTER_BOUNDS', 'Pointer arithmetic produced an address outside the array or beyond one-past.', at);
    }
    const result = Number(offset);
    if (!Number.isSafeInteger(result)) failure('POINTER_BOUNDS', 'The virtual address exceeds the representable profile.', at);
    return { type: pointer.type, value: { ...address, byteOffset: result } };
  }

  override pointerDifference(left: CValue, right: CValue, at: Location): CValue {
    const leftBase = pointedToType(left.type), rightBase = pointedToType(right.type);
    const characterRepresentation = !!leftBase && !!rightBase && isCharacterType(leftBase) && isCharacterType(rightBase);
    if (!leftBase || !rightBase || !sameType(leftBase, rightBase) || !left.value || !right.value ||
      typeof left.value !== 'object' || typeof right.value !== 'object' || left.value.kind !== 'object-pointer' || right.value.kind !== 'object-pointer') {
      failure('INVALID_POINTER_DIFFERENCE', 'Pointer subtraction requires compatible pointers into the same array.', at);
    }
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    const a = left.value, b = right.value;
    if (a.allocationId !== b.allocationId || (!characterRepresentation && a.arrayId !== b.arrayId)) {
      failure('INVALID_POINTER_DIFFERENCE', 'Subtracting pointers to distinct objects is undefined.', at);
    }
    const stride = sizeOfType(leftBase, this.aggregates, at);
    const difference = BigInt(a.byteOffset - b.byteOffset);
    if (difference % BigInt(stride) !== 0n) failure('INVALID_POINTER_DIFFERENCE', 'The difference is not an integer number of elements.', at);
    const result = difference / BigInt(stride);
    if (result < -(1n << 63n) || result > (1n << 63n) - 1n) failure('POINTER_DIFFERENCE_RANGE', 'Pointer difference exceeds ptrdiff_t in this profile.', at);
    return { type: 'long', value: result };
  }

  override pointerRelationalCompare(left: CValue, right: CValue, operator: string, at: Location): boolean {
    const leftBase = pointedToType(left.type), rightBase = pointedToType(right.type);
    if (!leftBase || !rightBase || !compatibleType(unqualifiedType(leftBase), unqualifiedType(rightBase)) ||
        !left.value || !right.value || typeof left.value !== 'object' || typeof right.value !== 'object' ||
        left.value.kind !== 'object-pointer' || right.value.kind !== 'object-pointer') {
      failure('INVALID_POINTER_COMPARISON', 'Relational comparison requires pointers to compatible objects.', at);
    }
    const a = left.value, b = right.value;
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    if (a.allocationId !== b.allocationId) {
      failure('INVALID_POINTER_COMPARISON', 'Relational comparison of pointers to distinct objects is undefined.', at);
    }

    let comparison: number;
    if (a.arrayId === b.arrayId) {
      comparison = a.byteOffset < b.byteOffset ? -1 : a.byteOffset > b.byteOffset ? 1 : 0;
    } else {
      const leftObject = this.records.get(a.arrayId);
      const rightObject = this.records.get(b.arrayId);
      const parentId = leftObject?.parentId;
      const parent = parentId === undefined ? undefined : this.records.get(parentId);
      if (!leftObject || !rightObject || leftObject.byteOffset !== a.byteOffset || rightObject.byteOffset !== b.byteOffset ||
          !sameType(leftObject.type, leftBase) || !sameType(rightObject.type, rightBase) ||
          parentId === undefined || parentId !== rightObject.parentId || !parent || !aggregateType(parent.type)) {
        failure('INVALID_POINTER_COMPARISON', 'Relational comparison requires elements of the same array or members of the same aggregate.', at);
      }
      const definition = this.aggregate(parent.type, at);
      if (leftObject.memberIndex === undefined || rightObject.memberIndex === undefined) {
        failure('INVALID_POINTER_COMPARISON', 'Relational comparison requires members of the same aggregate.', at);
      }
      if (definition.kind === 'union') comparison = 0;
      else comparison = leftObject.memberIndex < rightObject.memberIndex ? -1
        : leftObject.memberIndex > rightObject.memberIndex ? 1 : 0;
    }

    return operator === '<' ? comparison < 0
      : operator === '>' ? comparison > 0
        : operator === '<=' ? comparison <= 0 : comparison >= 0;
  }

  override assertAlive(pointer: CValue, at: Location): void {
    if (pointer.value === null) return;
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_ACCESS', 'The value does not represent a pointer.', at);
    if (pointer.value.kind === 'function-pointer') return;
    if (pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_ACCESS', 'The value does not represent an object pointer.', at);
    const root = this.roots.get(pointer.value.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
  }

  /** Format the actual LP64 virtual pointer representation for the library's %p conversion. */
  override formatPointer(pointer: CValue, at: Location): string {
    if (!isPointer(pointer.type)) failure('INVALID_POINTER_FORMAT', 'The %p value is not a pointer.', at);
    if (pointer.value === null) return '0x0';
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_FORMAT', 'The %p value is not a pointer representation.', at);
    if (pointer.value.kind === 'object-pointer') {
      this.assertAlive(pointer, at);
      const value = pointer.value;
      const root = this.roots.get(value.allocationId);
      const array = this.records.get(value.arrayId);
      if (!root || !array || array.allocationId !== value.allocationId || value.boundsStart < 0 ||
          value.boundsEnd > root.size || value.boundsStart > value.byteOffset || value.byteOffset > value.boundsEnd) {
        failure('INVALID_POINTER_REPRESENTATION', 'The pointer does not retain valid provenance for %p.', at);
      }
      const address = root.virtualBase + BigInt(value.byteOffset);
      this.formattedObjectPointers.set(address, value);
      return `0x${address.toString(16)}`;
    }
    if (pointer.value.kind === 'function-pointer') {
      if (pointer.value.functionIndex === null) return '0x0';
      if (!Number.isSafeInteger(pointer.value.functionIndex) || pointer.value.functionIndex < 0) {
        failure('INVALID_POINTER_FORMAT', 'The function pointer does not have a valid representation.', at);
      }
      return `0x${((1n << 63n) | BigInt(pointer.value.functionIndex + 1)).toString(16)}`;
    }
    failure('INVALID_POINTER_FORMAT', 'The %p value is not a pointer.', at);
  }

  /** Return the session's LP64 representation for an object or function pointer cast. */
  override pointerInteger(pointer: CValue, at: Location): bigint {
    if (!isPointer(pointer.type)) failure('INVALID_CONVERSION', 'Conversion requires a pointer.', at);
    if (pointer.value === null) return 0n;
    if (typeof pointer.value !== 'object') failure('INVALID_POINTER_REPRESENTATION', 'The value does not represent a pointer.', at);
    if (pointer.value.kind === 'function-pointer') {
      if (pointer.value.functionIndex === null) return 0n;
      const address = (1n << 63n) | BigInt(pointer.value.functionIndex + 1);
      this.integerPointerValues.set(address, { ...pointer.value });
      return address;
    }
    if (pointer.value.kind !== 'object-pointer') failure('INVALID_POINTER_REPRESENTATION', 'The value does not represent a pointer.', at);
    this.assertAlive(pointer, at);
    const root = this.roots.get(pointer.value.allocationId);
    if (!root) failure('INVALID_POINTER_REPRESENTATION', 'The pointer does not identify a virtual object.', at);
    const address = root.virtualBase + BigInt(pointer.value.byteOffset);
    this.integerPointerValues.set(address, { ...pointer.value });
    return address;
  }

  /** Reconstruct only known or currently mapped virtual addresses; provenance is retained when available. */
  override pointerFromInteger(value: bigint, type: CType, at: Location): CValue {
    const pointer = pointerType(type);
    if (!pointer) failure('INVALID_CONVERSION', 'Integer conversion requires a pointer type.', at);
    const address = BigInt.asUintN(64, value);
    if (address === 0n) return { type, value: null };
    const expectsFunction = isFunction(pointedToType(type) ?? 'void');
    const remembered = this.integerPointerValues.get(address) ?? this.formattedObjectPointers.get(address) ?? this.functionRepresentations.get(address);
    if (remembered) {
      if (expectsFunction !== (remembered.kind === 'function-pointer')) {
        failure('INVALID_POINTER_CONVERSION', 'The integer representation belongs to a different pointer category.', at);
      }
      return { type, value: { ...remembered } };
    }
    if (expectsFunction) failure('INVALID_POINTER_REPRESENTATION', 'The integer does not correspond to a known function address.', at);
    for (const root of this.roots.values()) {
      const delta = address - root.virtualBase;
      if (delta < 0n || delta > BigInt(root.size)) continue;
      const byteOffset = Number(delta);
      return {
        type,
        value: {
          kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.id,
          byteOffset, boundsStart: 0, boundsEnd: root.size,
        },
      };
    }
    failure('INVALID_POINTER_REPRESENTATION', 'The integer does not correspond to a known virtual address.', at);
  }

  /** Parse only null or an object-pointer representation previously emitted by formatPointer. */
  override parsePointer(text: string, at: Location): CValue {
    const match = /^0[xX]([0-9a-fA-F]+)$/.exec(text);
    if (!match) failure('INVALID_POINTER_REPRESENTATION', 'The %p input does not match a representation emitted by %p.', at);
    const address = BigInt(`0x${match[1]}`);
    if (address === 0n) return { type: pointerTo('void'), value: null };
    const value = this.formattedObjectPointers.get(address);
    if (!value) failure('INVALID_POINTER_REPRESENTATION', 'The %p input does not correspond to a known object pointer.', at);
    const pointer: CValue = { type: pointerTo('void'), value };
    this.assertAlive(pointer, at);
    return pointer;
  }

  override pointerEqual(left: CValue, right: CValue, at: Location = { file: 'main.c', line: 1, column: 1 }): boolean {
    this.assertAlive(left, at);
    this.assertAlive(right, at);
    if (left.value === null || right.value === null) return left.value === null && right.value === null;
    if (typeof left.value !== 'object' || typeof right.value !== 'object') return false;
    if (left.value.kind === 'function-pointer' && right.value.kind === 'function-pointer') return left.value.functionIndex === right.value.functionIndex;
    if (left.value.kind === 'object-pointer' && right.value.kind === 'object-pointer') {
      return left.value.allocationId === right.value.allocationId && left.value.byteOffset === right.value.byteOffset;
    }
    return false;
  }

  protected override arrayIndex(pointer: ObjectPointerValue): number | undefined {
    const root = this.records.get(pointer.arrayId);
    const array = root ? arrayType(root.type) : undefined;
    if (!array) return undefined;
    const stride = scalarOrAggregateSize(array.element, this.aggregates);
    return stride && (pointer.byteOffset - pointer.boundsStart) % stride === 0 ? (pointer.byteOffset - pointer.boundsStart) / stride : undefined;
  }
}
