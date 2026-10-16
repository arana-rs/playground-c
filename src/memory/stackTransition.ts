import type { DebugAggregateSnapshot, DebugArraySnapshot, DebugPointerSnapshot, DebugScalarSnapshot } from '@playground/c11-engine/core';
import type { MemoryViewerActiveScope, MemoryViewerLifecycleBatch } from './MemoryViewerController.ts';

export interface MemoryViewerStackTransition {
  readonly createdScalars: readonly DebugScalarSnapshot[];
  readonly deletedScalars: readonly DebugScalarSnapshot[];
  readonly createdPointers: readonly DebugPointerSnapshot[];
  readonly deletedPointers: readonly DebugPointerSnapshot[];
  readonly createdArrays: readonly DebugArraySnapshot[];
  readonly deletedArrays: readonly DebugArraySnapshot[];
  readonly createdAggregates: readonly DebugAggregateSnapshot[];
  readonly deletedAggregates: readonly DebugAggregateSnapshot[];
  readonly enteredScopes: readonly MemoryViewerActiveScope[];
  readonly exitedScopes: readonly MemoryViewerActiveScope[];
}

export interface MemoryViewerScalarValueSnapshot {
  readonly id: number;
  readonly initialized: boolean;
  readonly displayValue: string;
}

/** Return live IDs whose stored value or initialization state differs between two snapshots. */
export function findMemoryViewerChangedScalarIds<T extends MemoryViewerScalarValueSnapshot>(
  previous: readonly T[],
  current: readonly T[],
): readonly number[] {
  const previousById = new Map(previous.map(scalar => [scalar.id, scalar]));
  return current.flatMap(scalar => {
    const earlier = previousById.get(scalar.id);
    return earlier && (earlier.initialized !== scalar.initialized
      || earlier.displayValue !== scalar.displayValue)
      ? [scalar.id]
      : [];
  });
}

/** Map each function frame to its first entered scope, the function body's root scope. */
export function findMemoryViewerFunctionRootScopeIds(
  lifecycle: MemoryViewerLifecycleBatch | null,
): ReadonlyMap<number, number> {
  const batches: MemoryViewerLifecycleBatch[] = [];
  for (let batch: MemoryViewerLifecycleBatch | null = lifecycle; batch; batch = batch.previous) {
    batches.push(batch);
  }

  const rootScopeIdsByFrame = new Map<number, number>();
  for (let batchIndex = batches.length - 1; batchIndex >= 0; batchIndex -= 1) {
    for (const event of batches[batchIndex]!.events) {
      if (event.kind === 'scope-enter'
        && event.frameId !== null
        && event.scopeId !== null
        && !rootScopeIdsByFrame.has(event.frameId)) {
        rootScopeIdsByFrame.set(event.frameId, event.scopeId);
      }
    }
  }
  return rootScopeIdsByFrame;
}

/** Find the scope ID for the first (entrypoint) main frame from its lifecycle journal. */
export function findEntrypointMainRootScopeId(lifecycle: MemoryViewerLifecycleBatch | null): number | null {
  if (!lifecycle) return null;

  const batches: MemoryViewerLifecycleBatch[] = [];
  for (let batch: MemoryViewerLifecycleBatch | null = lifecycle; batch; batch = batch.previous) {
    batches.push(batch);
  }

  let entrypointFrameId: number | null = null;
  for (let batchIndex = batches.length - 1; batchIndex >= 0; batchIndex -= 1) {
    for (const event of batches[batchIndex]!.events) {
      if (event.kind === 'frame-enter' && event.functionName === 'main' && event.frameId !== null) {
        entrypointFrameId = event.frameId;
        break;
      }
    }
    if (entrypointFrameId !== null) break;
  }
  if (entrypointFrameId === null) return null;

  for (let batchIndex = batches.length - 1; batchIndex >= 0; batchIndex -= 1) {
    for (const event of batches[batchIndex]!.events) {
      if (event.kind === 'scope-enter' && event.frameId === entrypointFrameId && event.scopeId !== null) {
        return event.scopeId;
      }
    }
  }
  return null;
}

/** Compare only allocation/scope identities from two selected history snapshots. */
export function compareMemoryViewerStackSnapshots(
  previousScalars: readonly DebugScalarSnapshot[],
  currentScalars: readonly DebugScalarSnapshot[],
  previousScopes: readonly MemoryViewerActiveScope[],
  currentScopes: readonly MemoryViewerActiveScope[],
  previousArrays: readonly DebugArraySnapshot[] = [],
  currentArrays: readonly DebugArraySnapshot[] = [],
  previousPointers: readonly DebugPointerSnapshot[] = [],
  currentPointers: readonly DebugPointerSnapshot[] = [],
  previousAggregates: readonly DebugAggregateSnapshot[] = [],
  currentAggregates: readonly DebugAggregateSnapshot[] = [],
): MemoryViewerStackTransition {
  const previousScalarIds = new Set(previousScalars.map(scalar => scalar.id));
  const currentScalarIds = new Set(currentScalars.map(scalar => scalar.id));
  const previousArrayIds = new Set(previousArrays.map(array => array.rootId));
  const currentArrayIds = new Set(currentArrays.map(array => array.rootId));
  const previousPointerIds = new Set(previousPointers.filter(pointer => pointer.region === 'stack').map(pointer => pointer.id));
  const currentPointerIds = new Set(currentPointers.filter(pointer => pointer.region === 'stack').map(pointer => pointer.id));
  const previousAggregateIds = new Set(previousAggregates.filter(aggregate => aggregate.region === 'stack').map(aggregate => aggregate.rootId));
  const currentAggregateIds = new Set(currentAggregates.filter(aggregate => aggregate.region === 'stack').map(aggregate => aggregate.rootId));
  const previousScopeIds = new Set(previousScopes.map(scope => scope.id));
  const currentScopeIds = new Set(currentScopes.map(scope => scope.id));

  return {
    createdScalars: currentScalars.filter(scalar => !previousScalarIds.has(scalar.id)),
    deletedScalars: previousScalars.filter(scalar => !currentScalarIds.has(scalar.id)),
    createdPointers: currentPointers.filter(pointer => pointer.region === 'stack' && !previousPointerIds.has(pointer.id)),
    deletedPointers: previousPointers.filter(pointer => pointer.region === 'stack' && !currentPointerIds.has(pointer.id)),
    createdArrays: currentArrays.filter(array => !previousArrayIds.has(array.rootId)),
    deletedArrays: previousArrays.filter(array => !currentArrayIds.has(array.rootId)),
    createdAggregates: currentAggregates.filter(aggregate => aggregate.region === 'stack' && !previousAggregateIds.has(aggregate.rootId)),
    deletedAggregates: previousAggregates.filter(aggregate => aggregate.region === 'stack' && !currentAggregateIds.has(aggregate.rootId)),
    enteredScopes: currentScopes.filter(scope => !previousScopeIds.has(scope.id)),
    exitedScopes: previousScopes.filter(scope => !currentScopeIds.has(scope.id)),
  };
}

/** Pick one deterministic focal scalar, using the last changed position in stack order. */
export function chooseMemoryViewerStackFocusId(
  transition: MemoryViewerStackTransition,
  previousScalars: readonly DebugScalarSnapshot[],
  currentScalars: readonly DebugScalarSnapshot[],
  previousArrays: readonly DebugArraySnapshot[] = [],
  currentArrays: readonly DebugArraySnapshot[] = [],
  previousPointers: readonly DebugPointerSnapshot[] = [],
  currentPointers: readonly DebugPointerSnapshot[] = [],
  previousAggregates: readonly DebugAggregateSnapshot[] = [],
  currentAggregates: readonly DebugAggregateSnapshot[] = [],
): number | null {
  const previousIds = [...previousScalars.map(scalar => scalar.id), ...previousPointers.map(pointer => pointer.id), ...previousArrays.map(array => array.rootId), ...previousAggregates.map(aggregate => aggregate.rootId)]
    .sort((left, right) => left - right);
  const currentIds = [...currentScalars.map(scalar => scalar.id), ...currentPointers.map(pointer => pointer.id), ...currentArrays.map(array => array.rootId), ...currentAggregates.map(aggregate => aggregate.rootId)]
    .sort((left, right) => left - right);
  let focusedId: number | null = null;
  let focusedPosition = -1;
  let focusedWasCreated = false;

  for (const scalar of transition.deletedScalars) {
    const position = previousIds.indexOf(scalar.id);
    if (position > focusedPosition) {
      focusedId = scalar.id;
      focusedPosition = position;
      focusedWasCreated = false;
    }
  }

  for (const scalar of transition.createdScalars) {
    const position = currentIds.indexOf(scalar.id);
    if (position > focusedPosition || (position === focusedPosition && !focusedWasCreated)) {
      focusedId = scalar.id;
      focusedPosition = position;
      focusedWasCreated = true;
    }
  }

  for (const pointer of transition.deletedPointers) {
    const position = previousIds.indexOf(pointer.id);
    if (position > focusedPosition) {
      focusedId = pointer.id;
      focusedPosition = position;
      focusedWasCreated = false;
    }
  }

  for (const pointer of transition.createdPointers) {
    const position = currentIds.indexOf(pointer.id);
    if (position > focusedPosition || (position === focusedPosition && !focusedWasCreated)) {
      focusedId = pointer.id;
      focusedPosition = position;
      focusedWasCreated = true;
    }
  }

  for (const array of transition.deletedArrays) {
    const position = previousIds.indexOf(array.rootId);
    if (position > focusedPosition) {
      focusedId = array.rootId;
      focusedPosition = position;
      focusedWasCreated = false;
    }
  }

  for (const array of transition.createdArrays) {
    const position = currentIds.indexOf(array.rootId);
    if (position > focusedPosition || (position === focusedPosition && !focusedWasCreated)) {
      focusedId = array.rootId;
      focusedPosition = position;
      focusedWasCreated = true;
    }
  }

  for (const aggregate of transition.deletedAggregates) {
    const position = previousIds.indexOf(aggregate.rootId);
    if (position > focusedPosition) {
      focusedId = aggregate.rootId;
      focusedPosition = position;
      focusedWasCreated = false;
    }
  }

  for (const aggregate of transition.createdAggregates) {
    const position = currentIds.indexOf(aggregate.rootId);
    if (position > focusedPosition || (position === focusedPosition && !focusedWasCreated)) {
      focusedId = aggregate.rootId;
      focusedPosition = position;
      focusedWasCreated = true;
    }
  }

  return focusedId;
}

/** Keep exiting items beside their former neighbors while preserving the selected snapshot order. */
export function mergeExitedItemsInPreviousOrder<T extends { readonly id: number }>(
  previousIds: readonly number[],
  currentItems: readonly T[],
  exitingItems: readonly T[],
): T[] {
  const currentIds = new Set(currentItems.map(item => item.id));
  const exitingById = new Map(exitingItems
    .filter(item => !currentIds.has(item.id))
    .map(item => [item.id, item]));
  const result = [...currentItems];

  for (let previousIndex = 0; previousIndex < previousIds.length; previousIndex += 1) {
    const exiting = exitingById.get(previousIds[previousIndex]!);
    if (!exiting) continue;

    let insertionIndex = -1;
    for (let nextIndex = previousIndex + 1; nextIndex < previousIds.length; nextIndex += 1) {
      const survivingIndex = result.findIndex(item => item.id === previousIds[nextIndex]!);
      if (survivingIndex >= 0) {
        insertionIndex = survivingIndex;
        break;
      }
    }

    if (insertionIndex < 0) {
      for (let priorIndex = previousIndex - 1; priorIndex >= 0; priorIndex -= 1) {
        const survivingIndex = result.findIndex(item => item.id === previousIds[priorIndex]!);
        if (survivingIndex >= 0) {
          insertionIndex = survivingIndex + 1;
          break;
        }
      }
    }

    if (insertionIndex < 0) insertionIndex = result.length;
    result.splice(insertionIndex, 0, exiting);
    exitingById.delete(exiting.id);
  }

  // A valid transition always finds each exiting ID in the previous snapshot. Keep malformed
  // partial input deterministic too, without allowing it to disappear from presentation.
  for (const exiting of exitingById.values()) result.push(exiting);
  return result;
}
