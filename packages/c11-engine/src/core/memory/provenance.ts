import { MemoryRepresentations } from './representations.ts';
import { failure } from '../internal.ts';
import type { Location, ObjectPointerValue } from '../internal.ts';
import { aggregateType, arrayType, isScalar, sameType, sizeOfType, unqualifiedType } from '../type-system.ts';
import type { RuntimeObject, AllocationRoot, EffectiveTypeCopy } from './state.ts';

export abstract class MemoryProvenance extends MemoryRepresentations {

  /** Capture complete object-pointer representations for memcpy/memmove. */
  override copyablePointerValues(pointer: ObjectPointerValue, count: number, at: Location): readonly {
    readonly relativeOffset: number;
    readonly value: ObjectPointerValue;
  }[] {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    const pointerSize = 8;
    return Object.freeze([...root.pointerValues.entries()]
      .filter(([offset]) => offset >= pointer.byteOffset && offset + pointerSize <= end)
      .map(([offset, value]) => Object.freeze({ relativeOffset: offset - pointer.byteOffset, value: { ...value } })));
  }

  /** Restore provenance after those pointer bytes have been copied through character views. */
  override restoreCopiedPointerValues(
    pointer: ObjectPointerValue,
    count: number,
    values: readonly { readonly relativeOffset: number; readonly value: ObjectPointerValue }[],
    at: Location,
  ): void {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    this.clearPointerProvenance(root, pointer.byteOffset, end);
    for (const { relativeOffset, value } of values) {
      if (relativeOffset >= 0 && relativeOffset + 8 <= count) {
        root.pointerValues.set(pointer.byteOffset + relativeOffset, { ...value });
      }
    }
  }

  /** Capture effective-type shadow for the exact bytes copied by memcpy/memmove. */
  override copyableEffectiveTypes(pointer: ObjectPointerValue, count: number, at: Location): readonly EffectiveTypeCopy[] {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    if (root.rawAllocation) {
      return Object.freeze(root.effectiveTypes
        .filter((range) => range.start >= pointer.byteOffset && range.end <= end)
        .map((range) => Object.freeze({
          relativeOffset: range.start - pointer.byteOffset, size: range.end - range.start, type: range.type,
          ...(range.initialization === undefined ? {} : { initialization: range.initialization }),
        })));
    }
    const candidates = [...this.records.values()]
      .filter((node) => node.alive && node.allocationId === root.allocationId &&
        node.byteOffset === pointer.byteOffset && node.size === count)
      .sort((left, right) => Number(right.id === pointer.arrayId) - Number(left.id === pointer.arrayId));
    const source = candidates[0];
    return source
      ? Object.freeze([Object.freeze({
        relativeOffset: 0, size: count, type: unqualifiedType(source.type),
        initialization: this.copyInitializationSnapshot(source, at),
      })])
      : Object.freeze([]);
  }

  /** Replace destination shadow after byte-wise writes so copies retain source effective type. */
  override restoreCopiedEffectiveTypes(
    pointer: ObjectPointerValue,
    count: number,
    types: readonly EffectiveTypeCopy[],
    at: Location,
  ): void {
    const root = this.roots.get(pointer.allocationId);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The pointer refers to an object whose lifetime has ended.', at);
    const end = pointer.byteOffset + count;
    if (!Number.isSafeInteger(count) || count < 0 || pointer.byteOffset < pointer.boundsStart || end > pointer.boundsEnd) {
      failure('POINTER_BOUNDS', 'Copy exceeds the pointed-to object.', at);
    }
    if (count === 0) return;
    if (root.rawAllocation) {
      root.effectiveTypes.splice(0, root.effectiveTypes.length,
        ...root.effectiveTypes.filter((range) => range.end <= pointer.byteOffset || range.start >= end));
      for (const view of this.rawViews.get(root.allocationId)?.values() ?? []) {
        if (view.byteOffset < end && view.byteOffset + view.size > pointer.byteOffset) {
          this.resetTree(view, false);
          view.initializationShadow = undefined;
          view.initializationShadowApplied = false;
        }
      }
    }
    for (const item of types) {
      if (item.relativeOffset < 0 || item.size < 0 || item.relativeOffset + item.size > count) continue;
      const start = pointer.byteOffset + item.relativeOffset;
      const copiedType = unqualifiedType(item.type);
      if (root.rawAllocation) root.effectiveTypes.push({
        start,
        end: start + item.size,
        type: copiedType,
        ...(item.initialization === undefined ? {} : { initialization: item.initialization }),
      });
      else if (item.initialization !== undefined) {
        const target = [...this.records.values()].find((node) => node.alive && node.allocationId === root.allocationId &&
          node.byteOffset === start && node.size === item.size && sameType(node.type, copiedType));
        if (target) {
          this.resetTree(target, false);
          target.initializationShadow = undefined;
          target.initializationShadowApplied = false;
          this.applyInitializationSnapshot(target, item.initialization, at);
        }
      }
    }
    if (root.rawAllocation) this.applyInitializationShadows(root, at);
  }

  protected override clearPointerProvenance(root: AllocationRoot, start: number, end: number): void {
    for (const offset of root.pointerValues.keys()) {
      if (offset < end && offset + 8 > start) root.pointerValues.delete(offset);
    }
  }

  protected override invalidatePointerObjectCaches(root: AllocationRoot, start: number, end: number, preserveObjectId?: number): void {
    for (const node of root.pointerObjects) {
      if (node.id === preserveObjectId) continue;
      if (node.byteOffset < end && node.byteOffset + node.size > start) {
        node.initialized = false;
        node.value = undefined;
      }
    }
  }

  protected override readRepresentationByte(root: AllocationRoot, offset: number, at: Location): number {
    const stored = root.representation.get(offset);
    if (stored !== undefined) return stored;
    if (this.hasZeroInitializedAncestor(root)) return 0;
    const leaf = this.leafAt(root, offset, at);
    if (leaf && (leaf.initialized || this.hasZeroInitializedAncestor(leaf))) {
      if (isScalar(leaf.type) && leaf.value !== undefined) {
        const bytes = this.encodeScalar(leaf.type, this.readScalar(leaf, at), at);
        return bytes[offset - leaf.byteOffset] ?? 0;
      }
      return 0;
    }
    if (leaf) failure('UNINITIALIZED_READ', 'Reading a byte from an uninitialized object is undefined behavior in C11.', at);
    if (this.hasInitializedDescendant(root)) return 0; // LP64 profile choice for padding bytes.
    failure('UNINITIALIZED_READ', 'Reading a byte from an uninitialized object is undefined behavior in C11.', at);
  }

  protected override leafAt(parent: RuntimeObject, offset: number, at: Location): RuntimeObject | undefined {
    if (isScalar(parent.type)) return offset >= parent.byteOffset && offset < parent.byteOffset + parent.size ? parent : undefined;
    const array = arrayType(parent.type);
    const aggregate = aggregateType(parent.type);
    if (array) {
      const stride = sizeOfType(array.element, this.aggregates, at);
      const delta = offset - parent.byteOffset;
      if (delta < 0 || delta >= parent.size || array.length === null) return undefined;
      const index = Math.floor(delta / stride);
      const ref = this.child(parent, index, at);
      return this.leafAt(this.records.get(ref.objectId)!, offset, at);
    }
    if (aggregate) {
      const definition = this.aggregate(aggregate, at);
      const root = this.rootFor(parent, at);
      const candidates = definition.members.filter((member) => {
        const start = parent.byteOffset + member.offset;
        const memberSize = member.bitField
          ? member.bitField.storageUnitSize
          : member.flexibleArray
            ? Math.max(0, root.byteOffset + root.size - start)
            : sizeOfType(member.type, this.aggregates, at);
        return offset >= start && offset < start + memberSize;
      });
      if (definition.kind === 'union' && parent.activeMember !== undefined) {
        const active = candidates.find((member) => member.index === parent.activeMember);
        if (active) candidates.splice(0, candidates.length, active);
      }
      for (const member of candidates) {
        const ref = this.child(parent, member.index, at, member);
        const leaf = this.leafAt(this.records.get(ref.objectId)!, offset, at);
        if (leaf) return leaf;
      }
    }
    return undefined;
  }

  protected override hasZeroInitializedAncestor(node: RuntimeObject): boolean {
    let current: RuntimeObject | undefined = node;
    while (current) {
      if (current.zeroInitialized) return true;
      current = current.parentId === undefined ? undefined : this.records.get(current.parentId);
    }
    return false;
  }

  protected override hasInitializedDescendant(node: RuntimeObject): boolean {
    if (node.initialized || node.zeroInitialized) return true;
    for (const child of node.children.values()) if (this.hasInitializedDescendant(child)) return true;
    return false;
  }
}
