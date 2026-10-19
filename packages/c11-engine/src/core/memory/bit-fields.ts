import { MemoryEffectiveTypes } from './effective-types.ts';
import { failure } from '../internal.ts';
import type { AggregateDefinition, CType, Location, ObjectScalarValue } from '../internal.ts';
import { aggregateType, integerInfo, unqualifiedType } from '../type-system.ts';
import type { RuntimeObject } from './state.ts';

export abstract class MemoryBitFields extends MemoryEffectiveTypes {
  protected override bitFieldFor(node: RuntimeObject, at: Location): {
    readonly parent: RuntimeObject;
    readonly member: AggregateDefinition['members'][number];
  } | undefined {
    if (node.memberIndex === undefined || node.parentId === undefined) return undefined;
    const parent = this.records.get(node.parentId);
    const aggregate = parent ? aggregateType(parent.type) : undefined;
    if (!parent || !aggregate) return undefined;
    const member = this.aggregate(aggregate, at).members[node.memberIndex];
    return member?.bitField && member.bitField.width > 0 ? { parent, member } : undefined;
  }

  protected override bitFieldPromotionType(type: CType, bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>): CType {
    const declared = unqualifiedType(type);
    const info = integerInfo(declared);
    if (!info) return declared;
    if (info.rank < 3 || info.rank === 3 && bitField.width < info.bits) return 'int';
    return declared;
  }

  protected override readBitField(
    node: RuntimeObject,
    bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>,
    at: Location,
  ): ObjectScalarValue {
    const root = this.rootFor(node, at);
    const size = bitField.storageUnitSize;
    if (!node.initialized && !this.hasZeroInitializedAncestor(node)) {
      failure('UNINITIALIZED_READ', 'Reading an uninitialized bit-field is undefined behavior in C11.', at);
    }
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? (this.hasZeroInitializedAncestor(node) ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) failure('UNINITIALIZED_READ', 'The bit-field unit contains indeterminate bits.', at);
    const raw = this.fromBytes(bytes as number[]);
    const value = (raw >> BigInt(bitField.bitOffset)) & ((1n << BigInt(bitField.width)) - 1n);
    return bitField.signed ? BigInt.asIntN(bitField.width, value) : value;
  }

  protected override writeBitField(
    node: RuntimeObject,
    bitField: NonNullable<AggregateDefinition['members'][number]['bitField']>,
    value: ObjectScalarValue,
    at: Location,
  ): bigint {
    if (typeof value !== 'bigint') failure('TYPE_ERROR', 'The bit-field value must be an integer.', at);
    const root = this.rootFor(node, at);
    const widthMask = (1n << BigInt(bitField.width)) - 1n;
    const shiftedMask = widthMask << BigInt(bitField.bitOffset);
    const oldBytes = Array.from({ length: bitField.storageUnitSize }, (_, index) =>
      root.representation.get(node.byteOffset + index) ?? 0);
    const oldValue = this.fromBytes(oldBytes);
    const nextValue = (oldValue & ~shiftedMask) | ((BigInt.asUintN(bitField.width, value) & widthMask) << BigInt(bitField.bitOffset));
    const bytes = this.toBytes(nextValue, bitField.storageUnitSize);
    const end = node.byteOffset + bitField.storageUnitSize;
    this.clearPointerProvenance(root, node.byteOffset, end);
    this.invalidatePointerObjectCaches(root, node.byteOffset, end);
    bytes.forEach((byte, index) => root.representation.set(node.byteOffset + index, byte));
    const assigned = bitField.signed ? BigInt.asIntN(bitField.width, value) : BigInt.asUintN(bitField.width, value);
    node.value = assigned;
    node.initialized = true;
    node.zeroInitialized = false;
    this.recordEffectiveType(node, node.type, at);
    return assigned;
  }
}
