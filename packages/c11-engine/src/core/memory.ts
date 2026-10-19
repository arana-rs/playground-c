import { MemoryProvenance } from './memory/provenance.ts';
import type { AggregateDefinition } from './internal.ts';
import type { EngineMetrics } from './types.ts';
export type { MemoryAllocationOptions, EffectiveTypeCopy } from './memory/state.ts';

/**
 * A session-local, typed object store. It models C object identity and lifetime
 * without exposing host memory or byte buffers to the language implementation.
 */
export class VirtualMemory extends MemoryProvenance {
  constructor(
    aggregates: readonly AggregateDefinition[],
    maxMemoryBytes: number | null,
    metrics: EngineMetrics,
    heapAddressRandom: () => number = Math.random,
    retainPointerAllocationAddresses = false,
  ) {
    super(aggregates, maxMemoryBytes, metrics, heapAddressRandom, retainPointerAllocationAddresses);
  }
}
