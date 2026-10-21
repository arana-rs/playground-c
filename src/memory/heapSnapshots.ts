import type {
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
} from '@playground/c11-engine/core';
import { mergeExitedItemsInPreviousOrder } from './stackTransition.ts';
import type { MemoryViewerLifecycleBatch } from './memoryViewerControllerTypes.ts';

/** Derive the most recently released heap root from the selected event prefix. */
export function latestFreedMemoryViewerHeapObject(
  lifecycle: MemoryViewerLifecycleBatch | null,
): DebugHeapObjectSnapshot | null {
  const event = lifecycle?.latestFreedHeapEvent;
  return event ? Object.freeze({
    id: event.allocationId,
    address: `0x${event.addressVirtual.toString(16)}`,
    size: event.size,
    origin: 'heap',
  }) : null;
}

/**
 * Derive short C dereference labels for live heap roots from the selected
 * inspector snapshots. Allocation identity, rather than the displayed
 * address, keeps a freed/reused block from inheriting an old pointer label.
 */
export function memoryViewerHeapAliases(
  heapObjects: readonly DebugHeapObjectSnapshot[],
  pointers: readonly DebugPointerSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): ReadonlyMap<number, string> {
  const liveHeapIds = new Set(heapObjects.map(block => block.id));
  const destinationsByExpression = new Map<string, Map<string, {
    readonly allocationId: number | null;
    readonly byteOffset: number | null;
    readonly isLivePointerValue: boolean;
  }>>();

  const recordBinding = (
    status: DebugPointerSnapshot['status'] | undefined,
    initialized: boolean | null,
    target: DebugPointerSnapshot['target'] | undefined,
    expression: string,
  ) => {
    if (!expression) return;
    const isLivePointerValue = status === 'live' && initialized === true && target !== undefined;
    const destinationKey = isLivePointerValue
      ? `live:${target.allocationId}:${target.byteOffset}`
      : `state:${status ?? 'unknown'}:${initialized}:${target ? `${target.allocationId}:${target.byteOffset}` : 'none'}`;
    const destinations = destinationsByExpression.get(expression) ?? new Map();
    destinations.set(destinationKey, {
      allocationId: target?.allocationId ?? null,
      byteOffset: target?.byteOffset ?? null,
      isLivePointerValue,
    });
    destinationsByExpression.set(expression, destinations);
  };

  for (const pointer of pointers) {
    recordBinding(pointer.status, pointer.initialized, pointer.target, pointer.name);
  }

  for (const array of arrays) {
    if (!array.name) continue;
    for (const element of array.elements) {
      if (element.kind !== 'pointer') continue;
      recordBinding(element.pointerStatus, element.initialized, element.target, `${array.name}[${element.index}]`);
    }
  }

  for (const aggregate of aggregates) {
    if (aggregate.region === 'heap' || !aggregate.name) continue;
    for (const member of aggregate.members) {
      if (member.kind !== 'pointer' || !member.name) continue;
      recordBinding(member.pointerStatus, member.initialized, member.target, `${aggregate.name}.${member.name}`);
    }
  }

  const expressionsByHeapId = new Map<number, Set<string>>();
  for (const [expression, destinations] of destinationsByExpression) {
    if (destinations.size !== 1) continue;
    const destination = destinations.values().next().value;
    if (!destination?.isLivePointerValue || destination.allocationId === null
      || destination.byteOffset !== 0 || !liveHeapIds.has(destination.allocationId)) continue;
    const expressions = expressionsByHeapId.get(destination.allocationId) ?? new Set<string>();
    expressions.add(expression);
    expressionsByHeapId.set(destination.allocationId, expressions);
  }

  return new Map([...expressionsByHeapId]
    .sort(([leftId], [rightId]) => leftId - rightId)
    .map(([allocationId, expressions]) => [
      allocationId,
      [...expressions]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map(expression => `*${expression}`)
        .join(', '),
    ]));
}

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
