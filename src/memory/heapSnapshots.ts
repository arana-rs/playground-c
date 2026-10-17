import type { DebugAggregateSnapshot, DebugHeapObjectSnapshot } from '@playground/c11-engine/core';
import { mergeExitedItemsInPreviousOrder } from './stackTransition.ts';

export interface MemoryViewerHeapTransition {
  readonly created: readonly DebugHeapObjectSnapshot[];
  readonly deleted: readonly DebugHeapObjectSnapshot[];
}

export function compareMemoryViewerHeapObjects(
  previous: readonly DebugHeapObjectSnapshot[],
  current: readonly DebugHeapObjectSnapshot[],
): MemoryViewerHeapTransition {
  const previousIds = new Set(previous.map(object => object.id));
  const currentIds = new Set(current.map(object => object.id));
  return {
    created: current.filter(object => !previousIds.has(object.id)),
    deleted: previous.filter(object => !currentIds.has(object.id)),
  };
}

/** Follow the last inserted block, or the last freed block while its exit card remains visible. */
export function chooseMemoryViewerHeapFocusId(
  transition: MemoryViewerHeapTransition,
): number | null {
  if (transition.created.length > 0) return transition.created.at(-1)!.id;
  return transition.deleted.at(-1)?.id ?? null;
}

/** Keep freed blocks at their former address while preserving Heap's address order. */
export function mergeMemoryViewerHeapObjects(
  previousIds: readonly number[],
  current: readonly DebugHeapObjectSnapshot[],
  exiting: readonly DebugHeapObjectSnapshot[],
): DebugHeapObjectSnapshot[] {
  return mergeExitedItemsInPreviousOrder(previousIds, current, exiting).sort((left, right) => {
    const leftAddress = BigInt(left.address);
    const rightAddress = BigInt(right.address);
    if (leftAddress < rightAddress) return -1;
    if (leftAddress > rightAddress) return 1;
    return left.id - right.id;
  });
}

export type MemoryViewerHeapDisplayItem =
  | { readonly kind: 'block'; readonly id: number; readonly snapshot: DebugHeapObjectSnapshot }
  | { readonly kind: 'aggregate'; readonly id: number; readonly snapshot: DebugAggregateSnapshot };

/**
 * Replace a raw heap card only when its typed aggregate snapshot covers that
 * allocation exactly. Partial or stale typed views are omitted from the heap
 * presentation so the complete raw allocation remains visible.
 */
export function mergeMemoryViewerHeapViews(
  blocks: readonly DebugHeapObjectSnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
  liveBlocks: readonly DebugHeapObjectSnapshot[] = blocks,
): MemoryViewerHeapDisplayItem[] {
  const blocksById = new Map(liveBlocks.map(block => [block.id, block]));
  const completeViews = aggregates.filter(aggregate => {
    if (aggregate.region !== 'heap') return false;
    const block = blocksById.get(aggregate.rootId);
    return block !== undefined
      && aggregate.address === block.address
      && aggregate.size === block.size;
  });
  const coveredIds = new Set(completeViews.map(aggregate => aggregate.rootId));
  return [
    ...blocks
      .filter(block => !coveredIds.has(block.id))
      .map(snapshot => ({ kind: 'block' as const, id: snapshot.id, snapshot })),
    ...completeViews.map(snapshot => ({ kind: 'aggregate' as const, id: snapshot.viewId ?? snapshot.rootId, snapshot })),
  ].sort((left, right) => {
    const leftAddress = BigInt(left.snapshot.address);
    const rightAddress = BigInt(right.snapshot.address);
    return leftAddress < rightAddress ? -1 : leftAddress > rightAddress ? 1 : left.id - right.id;
  });
}
