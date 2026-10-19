import { MemoryAllocation } from './allocation.ts';
import { failure } from '../internal.ts';
import type { Location, StorageDuration } from '../internal.ts';
import { VIRTUAL_MEMORY_LAYOUT } from '../types.ts';
import { ALLOCATION_ALIGNMENT } from './state.ts';
import type { AddressReservation } from './state.ts';

export abstract class MemoryAddressSpace extends MemoryAllocation {
  protected override reservationSlotCount(size: number): bigint {
    const bytesWithGuard = BigInt(size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes);
    return (bytesWithGuard + ALLOCATION_ALIGNMENT - 1n) / ALLOCATION_ALIGNMENT;
  }

  protected override regionForDuration(duration: StorageDuration): { readonly start: bigint; readonly endExclusive: bigint } {
    if (duration === 'heap') return VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    if (duration === 'automatic' || duration === 'compound-literal') return VIRTUAL_MEMORY_LAYOUT.stackAddressRange;
    return VIRTUAL_MEMORY_LAYOUT.staticAddressRange;
  }

  protected override extentsForDuration(duration: Exclude<StorageDuration, 'heap'>): Map<bigint, bigint> {
    return duration === 'automatic' || duration === 'compound-literal' ? this.stackExtents : this.staticExtents;
  }

  /** Find the lowest fitting aligned extent by inspecting live allocations, not reserved bytes. */
  protected override chooseSessionAddress(size: number, duration: Exclude<StorageDuration, 'heap'>, alignment: number): AddressReservation | undefined {
    const region = this.regionForDuration(duration);
    const slotCount = this.reservationSlotCount(size);
    const reservedBytes = slotCount * ALLOCATION_ALIGNMENT;
    const alignmentBytes = BigInt(alignment);
    const alignUp = (address: bigint): bigint => ((address + alignmentBytes - 1n) / alignmentBytes) * alignmentBytes;
    const occupied = [...this.extentsForDuration(duration).entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let candidate = alignUp(region.start);
    for (const [start, end] of occupied) {
      candidate = alignUp(candidate);
      if (candidate + reservedBytes <= start) return { virtualBase: candidate, endExclusive: candidate + reservedBytes };
      if (end > candidate) candidate = alignUp(end);
    }
    candidate = alignUp(candidate);
    if (candidate + reservedBytes <= region.endExclusive) {
      return { virtualBase: candidate, endExclusive: candidate + reservedBytes };
    }
    return undefined;
  }

  protected override failRegionExhaustion(size: number, duration: Exclude<StorageDuration, 'heap'>, at: Location): never {
    const regionName = duration === 'automatic' || duration === 'compound-literal' ? 'Stack' : 'Static';
    const code = regionName === 'Stack' ? 'STACK_ADDRESS_SPACE_EXHAUSTED' : 'STATIC_ADDRESS_SPACE_EXHAUSTED';
    failure(code, `Virtual region ${regionName} has no space to reserve ${size} C bytes and its guard.`, at);
  }

  /** Choose a random aligned start with bounded probes, then scan live extents once as fallback. */
  protected override heapReservationAt(
    size: number,
    virtualBase: bigint,
    ignoredFirstSlot?: bigint,
  ): AddressReservation | undefined {
    const heapRange = VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    const totalSlots = (heapRange.endExclusive - heapRange.start) / ALLOCATION_ALIGNMENT;
    const slotCount = this.reservationSlotCount(size);
    if (virtualBase < heapRange.start || virtualBase % ALLOCATION_ALIGNMENT !== 0n) return undefined;
    const first = (virtualBase - heapRange.start) / ALLOCATION_ALIGNMENT;
    if (first + slotCount > totalSlots) return undefined;
    const end = first + slotCount;
    for (const [occupiedStart, occupiedEnd] of this.heapExtents) {
      if (occupiedStart === ignoredFirstSlot) continue;
      if (first < occupiedEnd && occupiedStart < end) return undefined;
    }
    return {
      virtualBase,
      endExclusive: heapRange.start + end * ALLOCATION_ALIGNMENT,
      heapSlotCount: slotCount,
    };
  }

  protected override chooseHeapAddress(
    size: number, at: Location, ignoredFirstSlot?: bigint, alignment = Number(ALLOCATION_ALIGNMENT),
  ): AddressReservation | undefined {
    const heapRange = VIRTUAL_MEMORY_LAYOUT.heapAddressRange;
    const totalSlots = (heapRange.endExclusive - heapRange.start) / ALLOCATION_ALIGNMENT;
    const slotCount = this.reservationSlotCount(size);
    if (slotCount > totalSlots) return undefined;
    const latestStart = totalSlots - slotCount;
    const alignmentBytes = BigInt(alignment);
    const alignSlot = (slot: bigint): bigint => {
      if (alignment <= Number(ALLOCATION_ALIGNMENT)) return slot;
      const address = heapRange.start + slot * ALLOCATION_ALIGNMENT;
      const remainder = address % alignmentBytes;
      return remainder === 0n ? slot : slot + (alignmentBytes - remainder) / ALLOCATION_ALIGNMENT;
    };
    const randomStart = (): bigint => {
      const random = this.heapAddressRandom();
      if (!Number.isFinite(random) || random < 0 || random >= 1) {
        failure('ENGINE_INTERNAL_ERROR', 'The heap address generator produced an invalid value.', at);
      }
      // Slot counts in the configured heap region stay exactly representable as Number.
      return alignSlot(BigInt(Math.floor(random * Number(latestStart + 1n))));
    };
    const occupiedExtents = [...this.heapExtents.entries()]
      .filter(([start]) => start !== ignoredFirstSlot);
    const fits = (first: bigint): boolean => {
      const end = first + slotCount;
      for (const [occupiedStart, occupiedEnd] of occupiedExtents) {
        if (first < occupiedEnd && occupiedStart < end) return false;
      }
      return true;
    };
    for (let attempt = 0; attempt < 64; attempt++) {
      const first = randomStart();
      if (fits(first)) {
        const virtualBase = heapRange.start + first * ALLOCATION_ALIGNMENT;
        return { virtualBase, endExclusive: heapRange.start + (first + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
      }
    }

    // A sorted list of extents bounds this fallback by live allocation count,
    // rather than searching the enormous virtual address interval one slot at a time.
    const occupied = occupiedExtents
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let candidate = alignSlot(0n);
    for (const [start, end] of occupied) {
      if (candidate <= latestStart && candidate + slotCount <= start) {
        const virtualBase = heapRange.start + candidate * ALLOCATION_ALIGNMENT;
        return { virtualBase, endExclusive: heapRange.start + (candidate + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
      }
      if (end > candidate) candidate = alignSlot(end);
    }
    if (candidate <= latestStart) {
      const virtualBase = heapRange.start + candidate * ALLOCATION_ALIGNMENT;
      return { virtualBase, endExclusive: heapRange.start + (candidate + slotCount) * ALLOCATION_ALIGNMENT, heapSlotCount: slotCount };
    }
    return undefined;
  }
}
