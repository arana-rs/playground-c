import { isCharacterType } from './state.ts';
import { MemoryInspection } from './inspection.ts';
import { failure } from '../internal.ts';
import type { AggregateValue, CValue, Location, ObjectReference, ObjectScalarValue } from '../internal.ts';
import { compatibleType, isAggregate, isArray, unqualifiedType } from '../type-system.ts';

export abstract class MemoryValues extends MemoryInspection {
  override read(ref: ObjectReference, at: Location): CValue {
    const node = this.nodeFor(ref, at);
    if (isArray(node.type)) failure('ARRAY_VALUE', 'An array must decay to a pointer before it can be evaluated as an expression.', at);
    if (isAggregate(node.type)) {
      this.ensureEffectiveType(node, at);
      const aggregate: AggregateValue = { kind: 'aggregate-value', snapshot: this.snapshot(node, at) };
      return { type: unqualifiedType(node.type), value: aggregate };
    }
    const bitField = this.bitFieldFor(node, at);
    if (bitField) {
      this.ensureEffectiveType(node, at);
      const type = this.bitFieldPromotionType(node.type, bitField.member.bitField!);
      return { type, value: this.readBitField(node, bitField.member.bitField!, at) };
    }
    this.ensureEffectiveType(node, at);
    return { type: unqualifiedType(node.type), value: this.readScalar(node, at) };
  }

  override write(ref: ObjectReference, value: CValue, at: Location, initializing = false): CValue {
    const node = this.nodeFor(ref, at);
    this.ensureWritable(node, at, initializing);
    if (node.byteView) {
      if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type))) failure('TYPE_ERROR', 'The value does not match the byte view’s char type.', at);
      if (!isCharacterType(node.type) || typeof value.value !== 'bigint') failure('TYPE_ERROR', 'The byte view requires an integer char value.', at);
      const root = this.rootFor(node, at);
      const byte = Number(BigInt.asUintN(8, value.value));
      this.clearPointerProvenance(root, node.byteOffset, node.byteOffset + 1);
      this.invalidatePointerObjectCaches(root, node.byteOffset, node.byteOffset + 1);
      root.representation.set(node.byteOffset, byte);
      node.value = BigInt.asIntN(8, BigInt(byte));
      node.initialized = true;
      return { type: unqualifiedType(node.type), value: node.value! };
    }
    this.activateContainingUnions(node, at);
    const bitField = this.bitFieldFor(node, at);
    if (bitField) {
      if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type)) || typeof value.value !== 'bigint') {
        failure('TYPE_ERROR', 'Bit-field assignment requires a compatible integer value.', at);
      }
      const assigned = this.writeBitField(node, bitField.member.bitField!, value.value, at);
      return { type: unqualifiedType(node.type), value: assigned };
    }
    if (isArray(node.type)) failure('INVALID_LVALUE', 'An array cannot be assigned as a complete object.', at);
    if (isAggregate(node.type)) {
      if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type)) || typeof value.value !== 'object' || value.value === null || value.value.kind !== 'aggregate-value') {
        failure('TYPE_ERROR', 'Aggregate assignment requires a value of the same type.', at);
      }
      this.restore(node, value.value.snapshot, at);
      this.recordEffectiveType(node, node.type, at);
      return { type: unqualifiedType(node.type), value: value.value };
    }
    if (!compatibleType(unqualifiedType(node.type), unqualifiedType(value.type))) failure('TYPE_ERROR', 'The value is incompatible with the object type.', at);
    if (typeof value.value === 'object' && value.value !== null && value.value.kind === 'aggregate-value') {
      failure('TYPE_ERROR', 'An aggregate value cannot be stored in a scalar object.', at);
    }
    node.value = value.value as ObjectScalarValue;
    node.initialized = true;
    this.writeRepresentation(node, node.value, at);
    this.recordEffectiveType(node, node.type, at);
    return { type: unqualifiedType(node.type), value: node.value };
  }

  override zeroInitialize(ref: ObjectReference, at: Location): void {
    const node = this.nodeFor(ref, at);
    this.ensureWritable(node, at, true);
    if (isArray(node.type) || isAggregate(node.type)) {
      this.clearRepresentation(node, at);
      node.initialized = true;
      node.zeroInitialized = true;
      if (isAggregate(node.type)) {
        const definition = this.aggregate(node.type, at);
        node.activeMember = definition.kind === 'union' ? 0 : undefined;
      }
      return;
    }
    node.value = this.zeroValue(node.type, at);
    node.initialized = true;
    this.writeRepresentation(node, node.value, at);
  }
}
