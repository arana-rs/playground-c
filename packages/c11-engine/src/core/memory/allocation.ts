import { MemoryBase } from './state.ts';
import { enforceLimit, failure } from '../internal.ts';
import type { CType, Location, ObjectPointerValue, ObjectReference, StorageDuration } from '../internal.ts';
import { aggregateType, alignOfType, arrayOf, arrayType, isPointer, qualifiersOf, sizeOfType, unqualifiedType } from '../type-system.ts';
import { VIRTUAL_HEAP_LAYOUT, VIRTUAL_MEMORY_LAYOUT } from '../types.ts';
import { ALLOCATION_ALIGNMENT } from './state.ts';
import type { AddressReservation, RuntimeObject, AllocationRoot, MemoryAllocationOptions } from './state.ts';

export abstract class MemoryAllocation extends MemoryBase {
  override canFree(pointer: ObjectPointerValue | null): boolean {
    if (pointer === null) return false;
    const root = this.roots.get(pointer.allocationId);
    return !!root?.alive && root.duration === 'heap' && root.rawAllocation &&
      pointer.byteOffset === root.byteOffset && pointer.arrayId === root.id;
  }

  override allocate(type: CType, duration: StorageDuration, at: Location, options: MemoryAllocationOptions = {}): ObjectReference {
    const size = sizeOfType(type, this.aggregates, at);
    const naturalAlignment = alignOfType(type, this.aggregates, at);
    const alignment = Math.max(naturalAlignment, options.alignment ?? 1);
    this.validateAlignment(alignment, at);
    return this.allocateRoot(type, size, duration, at, false, undefined, undefined, undefined, { ...options, alignment });
  }

  override allocateRaw(bytes: number, at: Location): ObjectPointerValue | null {
    return this.allocateRawAligned(bytes, Number(ALLOCATION_ALIGNMENT), at);
  }

  override allocateRawAligned(bytes: number, alignment: number, at: Location): ObjectPointerValue | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) failure('INVALID_ALLOCATION_SIZE', 'malloc requires a nonnegative safe integer size.', at);
    this.validateAlignment(alignment, at);
    // This profile chooses the permitted C11 behavior that malloc(0) returns null.
    if (bytes === 0) return null;
    const nextBytes = this.nextAllocationByteCount(bytes, at);
    const heapAddress = this.chooseHeapAddress(bytes, at, undefined, alignment);
    if (!heapAddress) return null;
    const root = this.allocateRoot(
      arrayOf('unsigned char', bytes), bytes, 'heap', at, true,
      nextBytes, heapAddress,
    );
    return {
      kind: 'object-pointer', allocationId: root.allocationId, arrayId: root.objectId,
      byteOffset: root.byteOffset, boundsStart: root.byteOffset, boundsEnd: root.byteOffset + bytes,
    };
  }

  override reallocateRaw(pointer: ObjectPointerValue | null, bytes: number, at: Location): ObjectPointerValue | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) failure('INVALID_ALLOCATION_SIZE', 'realloc requires a nonnegative safe integer size.', at);
    if (pointer === null) return this.allocateRaw(bytes, at);

    const oldRoot = this.roots.get(pointer.allocationId);
    if (!this.canFree(pointer) || !oldRoot) {
      failure('INVALID_REALLOC', 'realloc requires null or the base pointer of a live heap block.', at);
    }
    if (bytes === 0) {
      this.free(pointer, at);
      return null;
    }

    const nextBytes = this.liveBytes - oldRoot.size + bytes;
    enforceLimit('maxMemoryBytes', nextBytes, this.maxMemoryBytes, at);

    const oldFirstHeapSlot = (oldRoot.virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
    const reservation = this.heapReservationAt(bytes, oldRoot.virtualBase, oldFirstHeapSlot) ??
      this.chooseHeapAddress(bytes, at, oldFirstHeapSlot);
    if (!reservation) return null;

    const copiedBytes = Math.min(oldRoot.size, bytes);
    const representation = new Map(
      [...oldRoot.representation].filter(([offset]) => offset >= 0 && offset < copiedBytes),
    );
    const pointerValues = new Map(
      [...oldRoot.pointerValues]
        .filter(([offset]) => offset >= 0 && offset + 8 <= copiedBytes)
        .map(([offset, value]) => [offset, { ...value }] as const),
    );
    const effectiveTypes = oldRoot.effectiveTypes
      .filter((range) => range.start >= 0 && range.end <= copiedBytes)
      .map((range) => ({ ...range }));

    const newReference = this.allocateRoot(
      arrayOf('unsigned char', bytes), bytes, 'heap', at, true,
      nextBytes, reservation, oldFirstHeapSlot,
    );
    const newRoot = this.roots.get(newReference.allocationId);
    if (!newRoot) failure('ENGINE_INTERNAL_ERROR', 'Missing root for a newly reallocated heap object.', at);
    for (const [offset, byte] of representation) newRoot.representation.set(offset, byte);
    for (const [offset, value] of pointerValues) newRoot.pointerValues.set(offset, value);
    newRoot.effectiveTypes.push(...effectiveTypes);

    // A successful realloc creates a fresh C object identity even when its address stays put.
    this.invalidateRoot(oldRoot.allocationId, at);
    const newFirstHeapSlot = (newRoot.virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
    this.heapExtents.set(newFirstHeapSlot, newFirstHeapSlot + newRoot.heapSlotCount!);
    this.liveBytes = nextBytes;

    return {
      kind: 'object-pointer', allocationId: newRoot.allocationId, arrayId: newRoot.id,
      byteOffset: newRoot.byteOffset, boundsStart: newRoot.byteOffset, boundsEnd: newRoot.byteOffset + bytes,
    };
  }

  override release(ref: ObjectReference, at: Location): void {
    const node = this.nodeFor(ref, at);
    if (node.id !== node.allocationId) failure('INVALID_OBJECT_RELEASE', 'Only the lifetime of an automatic root object can be ended.', at);
    if (node.duration !== 'automatic' && node.duration !== 'compound-literal') failure('INVALID_OBJECT_RELEASE', 'The object does not have automatic storage duration.', at);
    this.invalidateRoot(node.allocationId, at);
  }

  override free(pointer: ObjectPointerValue | null, at: Location): void {
    if (pointer === null) return;
    const root = this.roots.get(pointer.allocationId);
    if (!root || !root.alive || root.duration !== 'heap' || !root.rawAllocation || pointer.byteOffset !== root.byteOffset || pointer.arrayId !== root.id) {
      failure('INVALID_FREE', 'free requires null or the base pointer of a live heap block.', at);
    }
    this.invalidateRoot(root.allocationId, at);
  }

  override staticObject(
    key: object,
    type: CType,
    at: Location,
    duration: StorageDuration = 'static',
    options: MemoryAllocationOptions = {},
  ): ObjectReference {
    const prior = this.staticObjects.get(key);
    if (prior) return prior;
    const ref = this.allocate(type, duration, at, options);
    this.staticObjects.set(key, ref);
    if (duration === 'string-literal') this.nodeFor(ref, at).readOnly = true;
    return ref;
  }

  override stringLiteral(key: object, bytes: readonly number[], at: Location): ObjectReference {
    const prior = this.staticObjects.get(key);
    if (prior) return prior;
    const ref = this.allocate(arrayOf('char', bytes.length + 1), 'string-literal', at);
    this.staticObjects.set(key, ref);
    for (let index = 0; index <= bytes.length; index++) {
      const byte = index === bytes.length ? 0 : bytes[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) failure('INVALID_STRING_LITERAL', 'The string literal contains a non-byte code unit.', at);
      const element = this.element(ref, index, at);
      const value = BigInt.asIntN(8, BigInt(byte));
      const node = this.nodeFor(element, at);
      node.value = value;
      node.initialized = true;
      this.writeRepresentation(node, value, at);
    }
    this.nodeFor(ref, at).readOnly = true;
    return ref;
  }

  override automaticObject(
    key: object,
    type: CType,
    scopeToken: object,
    at: Location,
    options: MemoryAllocationOptions = {},
  ): ObjectReference {
    let byScope = this.automaticObjects.get(key);
    if (!byScope) { byScope = new WeakMap(); this.automaticObjects.set(key, byScope); }
    const prior = byScope.get(scopeToken);
    if (prior) return prior;
    const ref = this.allocate(type, 'compound-literal', at, options);
    byScope.set(scopeToken, ref);
    let objects = this.scopeObjects.get(scopeToken);
    if (!objects) { objects = []; this.scopeObjects.set(scopeToken, objects); }
    objects.push(ref);
    return ref;
  }

  override releaseScope(scopeToken: object, at: Location): void {
    const objects = this.scopeObjects.get(scopeToken);
    if (!objects) return;
    for (let index = objects.length - 1; index >= 0; index--) {
      const ref = objects[index];
      const root = this.roots.get(ref.allocationId);
      if (root?.alive) this.invalidateRoot(root.allocationId, at);
    }
    this.scopeObjects.delete(scopeToken);
  }

  protected override allocateRoot(
    type: CType,
    size: number,
    duration: StorageDuration,
    at: Location,
    raw: boolean,
    reservedNextBytes?: number,
    heapReservation?: AddressReservation,
    ignoredHeapFirstSlot?: bigint,
    options: MemoryAllocationOptions = {},
  ): ObjectReference {
    const nextBytes = reservedNextBytes ?? this.nextAllocationByteCount(size, at);
    const alignment = options.alignment ?? Number(ALLOCATION_ALIGNMENT);
    this.validateAlignment(alignment, at);
    const reservation = duration === 'heap'
      ? heapReservation ?? failure('ENGINE_INTERNAL_ERROR', 'Missing selected address for a heap allocation.', at)
      : this.chooseSessionAddress(size, duration, alignment) ?? this.failRegionExhaustion(size, duration, at);
    const virtualBase = reservation.virtualBase;
    const region = this.regionForDuration(duration);
    if (virtualBase < region.start || reservation.endExclusive > region.endExclusive ||
        virtualBase + BigInt(size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) > reservation.endExclusive ||
        virtualBase % BigInt(alignment) !== 0n) {
      failure('ENGINE_INTERNAL_ERROR', 'The virtual reservation is outside its region or violates alignment or guard requirements.', at);
    }
    if (duration === 'heap') {
      if (reservation.heapSlotCount === undefined) {
        failure('ENGINE_INTERNAL_ERROR', 'Missing reserved size for a heap allocation.', at);
      }
      const firstHeapSlot = (virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      const endHeapSlot = firstHeapSlot + reservation.heapSlotCount;
      for (const [occupiedStart, occupiedEnd] of this.heapExtents) {
        if (occupiedStart === ignoredHeapFirstSlot) continue;
        if (firstHeapSlot < occupiedEnd && occupiedStart < endHeapSlot) {
          failure('ENGINE_INTERNAL_ERROR', 'The allocator selected an occupied heap range.', at);
        }
      }
    } else {
      const extents = this.extentsForDuration(duration);
      for (const [occupiedStart, occupiedEnd] of extents) {
        if (virtualBase < occupiedEnd && occupiedStart < reservation.endExclusive) {
          failure('ENGINE_INTERNAL_ERROR', 'The allocator selected an occupied object range.', at);
        }
      }
    }
    const id = this.nextObjectId++;
    const objectType = unqualifiedType(type);
    const root: AllocationRoot = {
      id, allocationId: id, type: objectType, byteOffset: 0, size, duration, rawAllocation: raw, alignment,
      virtualBase,
      representation: new Map(), pointerValues: new Map(), pointerObjects: new Set(), effectiveTypes: [], constRanges: [],
      ...(duration === 'heap' ? { heapSlotCount: reservation.heapSlotCount! } : {}),
      initialized: false, zeroInitialized: false, alive: true, children: new Map(),
      ...(options.isConst || qualifiersOf(type).const ? { readOnly: true } : {}),
    };
    if (root.readOnly && size > 0) root.constRanges.push({ start: 0, end: size });
    else this.collectConstRanges(root, objectType, 0, at);
    if (this.retainPointerAllocationAddresses) this.pointerAllocationAddresses.set(id, virtualBase);
    if (isPointer(type)) root.pointerObjects.add(root);
    this.records.set(id, root);
    this.roots.set(id, root);
    if (duration === 'heap') {
      const firstHeapSlot = (virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      this.heapExtents.set(firstHeapSlot, firstHeapSlot + reservation.heapSlotCount!);
    } else this.extentsForDuration(duration).set(virtualBase, reservation.endExclusive);
    this.liveBytes = nextBytes;
    this.metrics.peakMemoryBytes = Math.max(this.metrics.peakMemoryBytes, this.liveBytes);
    return this.reference(root);
  }

  protected override nextAllocationByteCount(size: number, at: Location): number {
    const nextBytes = this.liveBytes + size;
    enforceLimit('maxMemoryBytes', nextBytes, this.maxMemoryBytes, at);
    return nextBytes;
  }

  protected override validateAlignment(alignment: number, at: Location): void {
    if (!Number.isSafeInteger(alignment) || alignment < 1 || alignment > 65536 || (alignment & (alignment - 1)) !== 0) {
      failure('INVALID_ALIGNMENT', 'Alignment must be a power of two between 1 and 65536.', at);
    }
  }

  protected override collectConstRanges(root: AllocationRoot, type: CType, offset: number, at: Location): void {
    const size = sizeOfType(type, this.aggregates, at);
    if (qualifiersOf(type).const) {
      root.constRanges.push({ start: offset, end: offset + size });
      return;
    }
    const unqualified = unqualifiedType(type);
    const array = arrayType(unqualified);
    if (array) {
      if (array.length === null) return;
      const stride = sizeOfType(array.element, this.aggregates, at);
      for (let index = 0; index < array.length; index++) {
        this.collectConstRanges(root, array.element, offset + index * stride, at);
      }
      return;
    }
    const aggregate = aggregateType(unqualified);
    if (!aggregate) return;
    const definition = this.aggregate(aggregate, at);
    for (const member of definition.members) {
      if (member.bitField) {
        if (!qualifiersOf(member.type).const || member.bitField.width <= 0) continue;
        const bits = member.bitField;
        const mask = ((1n << BigInt(bits.width)) - 1n) << BigInt(bits.bitOffset);
        root.constRanges.push({
          start: offset + bits.storageUnitOffset,
          end: offset + bits.storageUnitOffset + bits.storageUnitSize,
          bitMask: mask,
        });
      } else if (member.flexibleArray) {
        const flexible = arrayType(member.type);
        if (!flexible || flexible.length !== null) continue;
        const elementSize = sizeOfType(flexible.element, this.aggregates, member.location);
        const start = offset + member.offset;
        const capacity = Math.max(0, root.size - start);
        const count = Math.floor(capacity / elementSize);
        for (let index = 0; index < count; index++) {
          this.collectConstRanges(root, flexible.element, start + index * elementSize, member.location);
        }
      } else {
        this.collectConstRanges(root, member.type, offset + member.offset, member.location);
      }
    }
  }

  protected override invalidateRoot(id: number, at: Location): void {
    const root = this.roots.get(id);
    if (!root?.alive) failure('INACTIVE_OBJECT', 'The object lifetime has already ended.', at);
    root.alive = false;
    this.liveBytes -= root.size;
    const pending: RuntimeObject[] = [root];
    while (pending.length) {
      const node = pending.pop()!;
      pending.push(...node.children.values());
      node.alive = false;
      node.children.clear();
      this.records.delete(node.id);
    }
    for (const view of this.rawViews.get(id)?.values() ?? []) {
      view.alive = false;
      view.children.clear();
      this.records.delete(view.id);
    }
    this.rawViews.delete(id);
    root.representation.clear();
    root.pointerValues.clear();
    root.pointerObjects.clear();
    this.roots.delete(id);
    if (root.duration === 'heap') {
      const firstHeapSlot = (root.virtualBase - VIRTUAL_HEAP_LAYOUT.start) / ALLOCATION_ALIGNMENT;
      this.heapExtents.delete(firstHeapSlot);
    } else this.extentsForDuration(root.duration).delete(root.virtualBase);
    for (const [address, pointer] of this.formattedObjectPointers) {
      if (pointer.allocationId === id) this.formattedObjectPointers.delete(address);
    }
  }
}
