import type { DebugHeapObjectSnapshot } from '@playground/c11-engine/core';
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
