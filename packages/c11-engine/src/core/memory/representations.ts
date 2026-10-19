import { MemoryBitFields } from './bit-fields.ts';
import { failure } from '../internal.ts';
import type { CType, Location, ObjectScalarValue } from '../internal.ts';
import { binary80Decode80, binary80Encode80 } from '../binary80.ts';
import { aggregateType, arrayType, functionType, integerInfo, isFunction, isInteger, isPointer, isScalar, pointedToType, pointerType, sizeOfType, unqualifiedType } from '../type-system.ts';
import type { RuntimeObject, AllocationRoot } from './state.ts';

export abstract class MemoryRepresentations extends MemoryBitFields {
  protected override rootFor(node: RuntimeObject, at: Location): AllocationRoot {
    const root = this.roots.get(node.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The object lifetime has ended.', at);
    return root;
  }

  protected override writeRepresentation(node: RuntimeObject, value: ObjectScalarValue, at: Location): void {
    if (!isScalar(node.type)) return;
    const root = this.rootFor(node, at);
    const bytes = this.encodeScalar(node.type, value, at);
    const end = node.byteOffset + bytes.length;
    this.clearPointerProvenance(root, node.byteOffset, end);
    this.invalidatePointerObjectCaches(root, node.byteOffset, end, node.id);
    if (isPointer(node.type) && value !== null && typeof value === 'object' && value.kind === 'object-pointer') {
      root.pointerValues.set(node.byteOffset, { ...value });
    }
    bytes.forEach((byte, index) => root.representation.set(node.byteOffset + index, byte));
  }

  protected override clearRepresentation(node: RuntimeObject, at: Location): void {
    const root = this.rootFor(node, at);
    const end = node.byteOffset + node.size;
    for (const offset of root.representation.keys()) if (offset >= node.byteOffset && offset < end) root.representation.delete(offset);
    this.clearPointerProvenance(root, node.byteOffset, end);
    this.invalidatePointerObjectCaches(root, node.byteOffset, end);
  }

  protected override readScalar(node: RuntimeObject, at: Location): ObjectScalarValue {
    const root = this.rootFor(node, at);
    if (node.byteView) {
      const byte = this.readRepresentationByte(root, node.byteOffset, at);
      return node.type === 'unsigned char' ? BigInt(byte) : BigInt.asIntN(8, BigInt(byte));
    }
    const size = sizeOfType(node.type, this.aggregates, at);
    const fullyRepresented = Array.from({ length: size }, (_, index) => root.representation.has(node.byteOffset + index)).every(Boolean);
    const zeroInitialized = this.hasZeroInitializedAncestor(node);
    if (node.rawView && !node.initialized && !zeroInitialized && !fullyRepresented) {
      failure('UNINITIALIZED_READ', 'malloc storage does not yet contain an object of this type.', at);
    }
    if (!node.initialized && !zeroInitialized && !fullyRepresented) {
      failure('UNINITIALIZED_READ', 'Reading an uninitialized object is undefined behavior in C11.', at);
    }
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? (zeroInitialized ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) failure('UNINITIALIZED_READ', 'The object representation contains indeterminate bytes.', at);
    if (isPointer(node.type)) {
      const pointerValue = root.pointerValues.get(node.byteOffset);
      if (pointerValue) return pointerValue;
    }
    if (node.initialized && isPointer(node.type) && node.value !== undefined) {
      const storedValue = this.encodeScalar(node.type, node.value, at);
      if (storedValue.every((byte, index) => byte === bytes[index])) return node.value;
    }
    return this.decodeScalar(node.type, bytes as number[], at);
  }

  protected override encodeScalar(type: CType, value: ObjectScalarValue, at: Location): number[] {
    type = unqualifiedType(type);
    const size = sizeOfType(type, this.aggregates, at);
    if (type === 'long double') {
      if (typeof value !== 'object' || value === null || value.kind !== 'binary80') {
        failure('TYPE_ERROR', 'long double requires a binary80 value.', at);
      }
      const payload = binary80Encode80(value);
      return Array.from({ length: size }, (_, index) => payload[index] ?? 0);
    }
    if (isPointer(type)) {
      let address = 0n;
      if (value !== null) {
        if (typeof value !== 'object') failure('INVALID_POINTER_REPRESENTATION', 'The value is not a pointer representation.', at);
        if (value.kind === 'object-pointer') {
          const target = this.roots.get(value.allocationId);
          if (!target) failure('INVALID_POINTER_REPRESENTATION', 'The pointer does not identify a virtual object.', at);
          address = target.virtualBase + BigInt(value.byteOffset);
        } else if (value.kind === 'function-pointer') {
          if (value.functionIndex !== null) {
            address = (1n << 63n) | BigInt(value.functionIndex + 1);
            this.functionRepresentations.set(address, value);
          }
        } else failure('INVALID_POINTER_REPRESENTATION', 'The value is not a pointer.', at);
      }
      return this.toBytes(address, size);
    }
    if (typeof value === 'number') {
      const buffer = new ArrayBuffer(size);
      const view = new DataView(buffer);
      if (type === 'float') view.setFloat32(0, value, true);
      else if (type === 'double') view.setFloat64(0, value, true);
      else failure('TYPE_ERROR', `Type ${String(type)} requires an integer representation.`, at);
      return Array.from(new Uint8Array(buffer));
    }
    if (typeof value !== 'bigint' || !isInteger(type)) failure('TYPE_ERROR', `No scalar representation exists for ${String(type)}.`, at);
    return this.toBytes(BigInt.asUintN(size * 8, value), size);
  }

  protected override decodeScalar(type: CType, bytes: number[], at: Location): ObjectScalarValue {
    type = unqualifiedType(type);
    if (type === 'long double') return binary80Decode80(bytes.slice(0, 10));
    if (isPointer(type)) {
      const address = this.fromBytes(bytes);
      if (address === 0n) return null;
      if (isFunction(pointedToType(type) ?? 'void')) {
        const known = this.functionRepresentations.get(address);
        if (known) return known;
        if ((address & (1n << 63n)) !== 0n) return { kind: 'function-pointer', functionIndex: Number(address & ((1n << 63n) - 1n)) - 1 };
        failure('INVALID_POINTER_REPRESENTATION', 'The bytes do not represent a valid function pointer in the LP64 profile.', at);
      }
      for (const root of this.roots.values()) {
        const delta = address - root.virtualBase;
        if (delta >= 0n && delta <= BigInt(root.size)) {
          return { kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.id,
            byteOffset: Number(delta), boundsStart: 0, boundsEnd: root.size };
        }
      }
      failure('INVALID_POINTER_REPRESENTATION', 'The bytes do not represent a valid object pointer in the LP64 profile.', at);
    }
    if (type === 'float' || type === 'double') {
      const view = new DataView(Uint8Array.from(bytes).buffer);
      return type === 'float' ? view.getFloat32(0, true) : view.getFloat64(0, true);
    }
    const info = integerInfo(type);
    if (!info || !isInteger(type)) failure('TYPE_ERROR', `No integer representation exists for ${String(type)}.`, at);
    const raw = this.fromBytes(bytes), bits = bytes.length * 8;
    if (type === '_Bool') return raw === 0n ? 0n : 1n;
    return info.unsigned ? BigInt.asUintN(bits, raw) : BigInt.asIntN(bits, raw);
  }

  protected override toBytes(value: bigint, size: number): number[] {
    const normalized = BigInt.asUintN(size * 8, value);
    return Array.from({ length: size }, (_, index) => Number((normalized >> BigInt(index * 8)) & 0xffn));
  }

  protected override fromBytes(bytes: readonly number[]): bigint {
    return bytes.reduce((value, byte, index) => value | BigInt(byte) << BigInt(index * 8), 0n);
  }

  protected override typeKey(type: CType): string {
    type = unqualifiedType(type);
    if (typeof type === 'string') return type;
    const pointer = pointerType(type);
    if (pointer) return `p(${this.typeKey(pointer.base)})`;
    const array = arrayType(type);
    if (array) return `a${array.length ?? '?'}(${this.typeKey(array.element)})`;
    const aggregate = aggregateType(type);
    if (aggregate) return `g${aggregate.id}`;
    if (typeof type !== 'string' && type.kind === 'enum') return `e${type.id}`;
    const fn = functionType(type);
    return fn ? `f(${this.typeKey(fn.returnType)}:${fn.parameters.map((item) => this.typeKey(item)).join(',')})` : 'unknown';
  }

  protected override get rawViews(): Map<number, Map<string, RuntimeObject>> {
    if (!this.rawViewsValue) this.rawViewsValue = new Map();
    return this.rawViewsValue;
  }
}
