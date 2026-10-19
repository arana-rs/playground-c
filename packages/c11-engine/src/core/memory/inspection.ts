import { MemoryPointerOperations } from './pointers.ts';
import { failure } from '../internal.ts';
import type { CType, Location, ObjectReference, ObjectScalarValue } from '../internal.ts';
import { aggregateType, arrayType, isArithmetic, isFunction, isPointer, isScalar, pointedToType, sizeOfType, unqualifiedType } from '../type-system.ts';
import type { AllocationRoot, PointerInspectionResult } from './state.ts';

export abstract class MemoryInspection extends MemoryPointerOperations {
  override flexibleArrayExtent(ref: ObjectReference, memberIndex: number, at: Location): {
    readonly elementSize: number;
    readonly capacityBytes: number;
    readonly length: number;
  } | undefined {
    const node = this.nodeFor(ref, at);
    const aggregate = aggregateType(node.type);
    if (!aggregate) return undefined;
    const definition = this.aggregate(aggregate, at);
    const member = definition.members[memberIndex];
    if (!member?.flexibleArray || definition.flexibleOffset === undefined) return undefined;
    const array = arrayType(member.type);
    if (!array) return undefined;
    const elementSize = sizeOfType(array.element, this.aggregates, member.location);
    const offset = node.byteOffset + definition.flexibleOffset;
    const capacityBytes = Math.max(0, this.rootFor(node, at).size - offset);
    return Object.freeze({ elementSize, capacityBytes, length: Math.floor(capacityBytes / elementSize) });
  }

  /** Inspect one arithmetic FAM cell from representation/shadow state without creating a subobject or C read. */
  override inspectFlexibleArrayElement(
    ref: ObjectReference,
    memberIndex: number,
    index: number,
    at: Location,
  ): { readonly initialized: boolean; readonly value?: ObjectScalarValue } | undefined {
    const parent = this.nodeFor(ref, at);
    const aggregate = aggregateType(parent.type);
    if (!aggregate) return undefined;
    const definition = this.aggregate(aggregate, at);
    const member = definition.members[memberIndex];
    const array = member?.flexibleArray ? arrayType(member.type) : undefined;
    if (!member?.flexibleArray || !array || !isArithmetic(array.element) || definition.flexibleOffset === undefined) return undefined;
    const extent = this.flexibleArrayExtent(ref, memberIndex, at);
    if (!extent || !Number.isSafeInteger(index) || index < 0 || index >= extent.length) return undefined;

    const arrayNode = parent.children.get(memberIndex);
    const child = arrayNode?.children.get(index);
    const zeroInitialized = child
      ? this.hasZeroInitializedAncestor(child)
      : arrayNode
        ? this.hasZeroInitializedAncestor(arrayNode)
        : this.hasZeroInitializedAncestor(parent);
    const byteOffset = parent.byteOffset + definition.flexibleOffset + index * extent.elementSize;
    return this.inspectArithmeticRepresentation(
      this.rootFor(parent, at),
      array.element,
      byteOffset,
      extent.elementSize,
      child?.initialized ?? false,
      zeroInitialized,
      at,
    );
  }

  /** Inspect an arithmetic scalar without turning an indeterminate read into a VM diagnostic. */
  override inspectScalar(ref: ObjectReference, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    const node = this.nodeFor(ref, at);
    if (!isScalar(node.type) || isPointer(node.type)) {
      failure('TYPE_ERROR', 'Scalar inspection requires an arithmetic object.', at);
    }
    const root = this.rootFor(node, at);
    const zeroInitialized = this.hasZeroInitializedAncestor(node);
    let fullyRepresented = true;
    for (let index = 0; index < node.size; index++) {
      if (!root.representation.has(node.byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    const initialized = node.initialized || zeroInitialized || fullyRepresented;
    return initialized
      ? { initialized: true, value: this.readScalar(node, at) }
      : { initialized: false };
  }

  /** Inspect pointer bytes and provenance without invoking a C pointer read or validating its target. */
  override inspectPointer(ref: ObjectReference, at: Location): PointerInspectionResult {
    const node = this.nodeFor(ref, at);
    if (!isPointer(node.type)) failure('TYPE_ERROR', 'Pointer inspection requires a pointer object.', at);
    const root = this.rootFor(node, at);
    return this.inspectPointerRepresentation(
      root,
      node.type,
      node.byteOffset,
      node.size,
      node.initialized,
      this.hasZeroInitializedAncestor(node),
      node.value,
      at,
    );
  }

  /** Inspect a pointer array cell without creating a child object or performing a C read. */
  override inspectArrayPointerElement(ref: ObjectReference, index: number, at: Location): PointerInspectionResult | undefined {
    const parent = this.nodeFor(ref, at);
    const array = arrayType(parent.type);
    if (!array || array.length === null || !isPointer(array.element) ||
        !Number.isSafeInteger(index) || index < 0 || index >= array.length) return undefined;
    const size = sizeOfType(array.element, this.aggregates, at);
    const byteOffset = parent.byteOffset + index * size;
    const child = parent.children.get(index);
    const zeroInitialized = child
      ? this.hasZeroInitializedAncestor(child)
      : this.hasZeroInitializedAncestor(parent);
    return this.inspectPointerRepresentation(
      this.rootFor(parent, at),
      array.element,
      byteOffset,
      size,
      child?.initialized ?? false,
      zeroInitialized,
      child?.value,
      at,
    );
  }

  /** Inspect an arithmetic array cell without creating its subobject node or performing a C read. */
  override inspectArrayElement(
    ref: ObjectReference,
    index: number,
    at: Location,
  ): { readonly initialized: boolean; readonly value?: ObjectScalarValue } | undefined {
    const parent = this.nodeFor(ref, at);
    const array = arrayType(parent.type);
    if (!array || array.length === null ||
        !Number.isSafeInteger(index) || index < 0 || index >= array.length ||
        !isArithmetic(array.element)) return undefined;

    const type = array.element;
    const size = sizeOfType(type, this.aggregates, at);
    const byteOffset = parent.byteOffset + index * size;
    const root = this.rootFor(parent, at);
    const child = parent.children.get(index);
    const zeroInitialized = child
      ? this.hasZeroInitializedAncestor(child)
      : this.hasZeroInitializedAncestor(parent);
    const fullyRepresented = Array.from({ length: size }, (_, byte) => root.representation.has(byteOffset + byte)).every(Boolean);
    if (!child?.initialized && !zeroInitialized && !fullyRepresented) return { initialized: false };

    const bytes = Array.from({ length: size }, (_, byte) =>
      root.representation.get(byteOffset + byte) ?? (zeroInitialized ? 0 : undefined));
    // Malformed or partially written representation metadata must stay an
    // indeterminate display state rather than becoming a diagnosticable C read.
    if (bytes.some((byte) => byte === undefined)) return { initialized: false };
    return { initialized: true, value: this.decodeScalar(type, bytes as number[], at) };
  }

  /** Inspect a direct arithmetic struct member without creating its lazy child node. */
  override inspectAggregateScalar(ref: ObjectReference, memberIndex: number, at: Location): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    const member = this.directStructMember(ref, memberIndex, at);
    if (!isArithmetic(member.type)) failure('TYPE_ERROR', 'Inspection requires an arithmetic struct member.', at);
    const child = member.parent.children.get(memberIndex);
    const definition = this.aggregate(member.parent.type, at);
    const bitField = definition.members[memberIndex]?.bitField;
    if (bitField) {
      const initialized = !!child?.initialized || member.zeroInitialized;
      return initialized
        ? { initialized: true, value: this.readBitField(child ?? this.nodeFor(this.member(ref, memberIndex, at), at), bitField, at) }
        : { initialized: false };
    }
    return this.inspectArithmeticRepresentation(
      member.root,
      member.type,
      member.byteOffset,
      sizeOfType(member.type, this.aggregates, at),
      child?.initialized ?? false,
      member.zeroInitialized,
      at,
    );
  }

  /** Inspect a direct pointer struct member without creating its lazy child node. */
  override inspectAggregatePointer(ref: ObjectReference, memberIndex: number, at: Location): PointerInspectionResult {
    const member = this.directStructMember(ref, memberIndex, at);
    if (!isPointer(member.type)) failure('TYPE_ERROR', 'Inspection requires a pointer struct member.', at);
    const child = member.parent.children.get(memberIndex);
    const size = sizeOfType(member.type, this.aggregates, at);
    return this.inspectPointerRepresentation(
      member.root,
      member.type,
      member.byteOffset,
      size,
      child?.initialized ?? false,
      member.zeroInitialized,
      child?.value,
      at,
    );
  }

  protected override inspectPointerRepresentation(
    root: AllocationRoot,
    type: CType,
    byteOffset: number,
    size: number,
    nodeInitialized: boolean,
    zeroInitialized: boolean,
    nodeValue: ObjectScalarValue | undefined,
    at: Location,
  ): PointerInspectionResult {
    if (!isPointer(type)) failure('TYPE_ERROR', 'Pointer inspection requires a pointer object.', at);
    let fullyRepresented = true;
    for (let index = 0; index < size; index += 1) {
      if (!root.representation.has(byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    const initialized = nodeInitialized || zeroInitialized || fullyRepresented;
    if (!initialized) return { initialized: false, status: 'uninitialized' };

    const value = root.pointerValues.get(byteOffset) ?? nodeValue;
    if (value === null) return { initialized: true, status: 'null', address: 0n };
    if (typeof value === 'object' && value !== null && value.kind === 'object-pointer') {
      if (!Number.isSafeInteger(value.byteOffset)) return { initialized: true, status: 'unmapped' };
      const target = { allocationId: value.allocationId, byteOffset: value.byteOffset };
      const targetRoot = this.roots.get(value.allocationId);
      const base = targetRoot?.virtualBase ?? this.pointerAllocationAddresses.get(value.allocationId);
      if (base === undefined) return { initialized: true, status: 'unmapped', target };
      const address = base + BigInt(value.byteOffset);
      if (!targetRoot) return { initialized: true, status: 'dangling', address, target };
      if (value.byteOffset === value.boundsEnd) return { initialized: true, status: 'one-past', address, target };
      if (value.byteOffset < value.boundsStart || value.byteOffset > value.boundsEnd) {
        return { initialized: true, status: 'unmapped', address, target };
      }
      return { initialized: true, status: 'live', address, target };
    }
    if (typeof value === 'object' && value !== null && value.kind === 'function-pointer') {
      const address = value.functionIndex === null
        ? 0n
        : (1n << 63n) | BigInt(value.functionIndex + 1);
      return address === 0n
        ? { initialized: true, status: 'null', address }
        : { initialized: true, status: 'function', address };
    }

    let address = 0n;
    for (let index = 0; index < size; index += 1) {
      const byte = root.representation.get(byteOffset + index) ?? (zeroInitialized ? 0 : undefined);
      if (byte === undefined) return { initialized: true, status: 'unmapped' };
      address |= BigInt(byte) << BigInt(index * 8);
    }
    if (address === 0n) return { initialized: true, status: 'null', address };
    if (isFunction(pointedToType(type) ?? 'void') &&
        (this.functionRepresentations.has(address) || (address & (1n << 63n)) !== 0n)) {
      return { initialized: true, status: 'function', address };
    }
    // Raw bytes alone never establish object identity, even if their address now falls
    // inside a newer allocation that reused a retired object's address.
    return { initialized: true, status: 'unmapped', address };
  }

  protected override inspectArithmeticRepresentation(
    root: AllocationRoot,
    type: CType,
    byteOffset: number,
    size: number,
    nodeInitialized: boolean,
    zeroInitialized: boolean,
    at: Location,
  ): { readonly initialized: boolean; readonly value?: ObjectScalarValue } {
    let fullyRepresented = true;
    for (let index = 0; index < size; index++) {
      if (!root.representation.has(byteOffset + index)) {
        fullyRepresented = false;
        break;
      }
    }
    if (!nodeInitialized && !zeroInitialized && !fullyRepresented) return { initialized: false };
    const bytes = Array.from({ length: size }, (_, index) =>
      root.representation.get(byteOffset + index) ?? (zeroInitialized ? 0 : undefined));
    if (bytes.some((byte) => byte === undefined)) return { initialized: false };
    return { initialized: true, value: this.decodeScalar(type, bytes as number[], at) };
  }

  /** Report allocation metadata only; this flag does not mediate C write semantics. */
  override isReadOnly(ref: ObjectReference, at: Location): boolean {
    return this.nodeFor(ref, at).readOnly === true;
  }

  /**
   * Read the stored bytes of an initialized string literal without creating
   * element objects or turning a missing representation into a C read error.
   */
  override inspectStringLiteral(ref: ObjectReference): readonly number[] | undefined {
    const node = this.records.get(ref.objectId);
    if (!node || node.allocationId !== ref.allocationId || !node.alive) return undefined;
    const root = this.roots.get(node.allocationId);
    const array = root ? arrayType(root.type) : undefined;
    if (!root?.alive || node.id !== root.id || root.duration !== 'string-literal' ||
        !array || unqualifiedType(array.element) !== 'char' || array.length === null ||
        array.length !== root.size) return undefined;

    const bytes: number[] = [];
    for (let offset = 0; offset < root.size; offset++) {
      const byte = root.representation.get(root.byteOffset + offset);
      if (byte === undefined) return undefined;
      bytes.push(byte);
    }
    if (bytes.at(-1) !== 0) return undefined;
    return Object.freeze(bytes);
  }
}
