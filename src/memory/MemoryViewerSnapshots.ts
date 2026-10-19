import type {
  DebugEvent,
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
} from '@playground/c11-engine/core';
import { PersistentSnapshotHistory } from './PersistentSnapshotHistory.ts';
import type { PersistentSnapshotBatch } from './PersistentSnapshotHistory.ts';
import { cloneMemoryViewerArraySnapshot, sameMemoryViewerArraySnapshot } from './arraySnapshots.ts';
import { cloneMemoryViewerAggregateSnapshot, sameMemoryViewerAggregateSnapshot } from './aggregateSnapshots.ts';
import { cloneMemoryViewerPointerSnapshot, sameMemoryViewerPointerSnapshot } from './pointerSnapshots.ts';
import type { MemoryViewerActiveScope, MemoryViewerLifecycleBatch } from './memoryViewerControllerTypes.ts';

export interface MemoryViewerSnapshotPayload {
  readonly events: readonly DebugEvent[];
  readonly heapObjects?: readonly DebugHeapObjectSnapshot[];
  readonly pointers?: readonly DebugPointerSnapshot[];
  readonly arrays?: readonly DebugArraySnapshot[];
  readonly omittedArrayObjects?: number;
  readonly aggregates?: readonly DebugAggregateSnapshot[];
  readonly omittedAggregateObjects?: number;
  readonly stackScalars?: readonly DebugScalarSnapshot[];
  readonly staticObjects?: readonly DebugStaticObjectSnapshot[];
}

interface ActiveScopeNode {
  readonly scope: MemoryViewerActiveScope;
  readonly previous: ActiveScopeNode | null;
}

export interface MemoryViewerSnapshotCheckpoint {
  readonly lifecycle: MemoryViewerLifecycleBatch | null;
  readonly activeScopeTop: ActiveScopeNode | null;
  readonly heapSnapshotHistory: PersistentSnapshotBatch<DebugHeapObjectSnapshot> | null;
  readonly pointerSnapshotHistory: PersistentSnapshotBatch<DebugPointerSnapshot> | null;
  readonly arraySnapshotHistory: PersistentSnapshotBatch<DebugArraySnapshot> | null;
  readonly omittedArrayObjects: number;
  readonly aggregateSnapshotHistory: PersistentSnapshotBatch<DebugAggregateSnapshot> | null;
  readonly omittedAggregateObjects: number;
  readonly stackSnapshotHistory: PersistentSnapshotBatch<DebugScalarSnapshot> | null;
  readonly staticSnapshotHistory: PersistentSnapshotBatch<DebugStaticObjectSnapshot> | null;
}

export interface MemoryViewerSnapshotProjection {
  readonly lifecycle: MemoryViewerLifecycleBatch | null;
  readonly activeScopes: readonly MemoryViewerActiveScope[];
  readonly heapObjects: readonly DebugHeapObjectSnapshot[];
  readonly pointers: readonly DebugPointerSnapshot[];
  readonly arrays: readonly DebugArraySnapshot[];
  readonly omittedArrayObjects: number;
  readonly aggregates: readonly DebugAggregateSnapshot[];
  readonly omittedAggregateObjects: number;
  readonly stackScalars: readonly DebugScalarSnapshot[];
  readonly staticObjects: readonly DebugStaticObjectSnapshot[];
}

/** Stores immutable inspector snapshots and the lifecycle prefix for each history point. */
export class MemoryViewerSnapshots {
  private readonly stackHistory = new PersistentSnapshotHistory<DebugScalarSnapshot>();
  private readonly staticHistory = new PersistentSnapshotHistory<DebugStaticObjectSnapshot>();
  private readonly arrayHistory = new PersistentSnapshotHistory<DebugArraySnapshot>(128, {
    getId: array => array.rootId,
    sameSnapshot: sameMemoryViewerArraySnapshot,
    cloneSnapshot: cloneMemoryViewerArraySnapshot,
  });
  private readonly aggregateHistory = new PersistentSnapshotHistory<DebugAggregateSnapshot>(128, {
    getId: aggregate => aggregate.viewId ?? aggregate.rootId,
    sameSnapshot: sameMemoryViewerAggregateSnapshot,
    cloneSnapshot: cloneMemoryViewerAggregateSnapshot,
  });
  private readonly heapHistory = new PersistentSnapshotHistory<DebugHeapObjectSnapshot>();
  private readonly pointerHistory = new PersistentSnapshotHistory<DebugPointerSnapshot>(128, {
    sameSnapshot: sameMemoryViewerPointerSnapshot,
    cloneSnapshot: cloneMemoryViewerPointerSnapshot,
  });
  private lastEventSequence = 0;
  private lifecycle: MemoryViewerLifecycleBatch | null = null;
  private activeScopeTop: ActiveScopeNode | null = null;
  private omittedArrayObjects = 0;
  private omittedAggregateObjects = 0;
  private usedHeap = false;

  get hasUsedHeap(): boolean { return this.usedHeap; }
  get omittedArrays(): number { return this.omittedArrayObjects; }
  get omittedAggregates(): number { return this.omittedAggregateObjects; }

  reset(): void {
    this.stackHistory.reset();
    this.staticHistory.reset();
    this.arrayHistory.reset();
    this.aggregateHistory.reset();
    this.heapHistory.reset();
    this.pointerHistory.reset();
    this.lastEventSequence = 0;
    this.lifecycle = null;
    this.activeScopeTop = null;
    this.omittedArrayObjects = 0;
    this.omittedAggregateObjects = 0;
    this.usedHeap = false;
  }

  accept(payload: MemoryViewerSnapshotPayload): void {
    this.acceptEvents(payload.events);
    this.heapHistory.accept(payload.heapObjects);
    this.pointerHistory.accept(payload.pointers);
    this.arrayHistory.accept(payload.arrays);
    this.omittedArrayObjects = Math.max(0, payload.omittedArrayObjects ?? 0);
    this.aggregateHistory.accept(payload.aggregates);
    this.omittedAggregateObjects = Math.max(0, payload.omittedAggregateObjects ?? 0);
    this.stackHistory.accept(payload.stackScalars);
    this.staticHistory.accept(payload.staticObjects);
  }

  capture(): MemoryViewerSnapshotCheckpoint {
    return {
      lifecycle: this.lifecycle,
      activeScopeTop: this.activeScopeTop,
      heapSnapshotHistory: this.heapHistory.latestBatch,
      pointerSnapshotHistory: this.pointerHistory.latestBatch,
      arraySnapshotHistory: this.arrayHistory.latestBatch,
      omittedArrayObjects: this.omittedArrayObjects,
      aggregateSnapshotHistory: this.aggregateHistory.latestBatch,
      omittedAggregateObjects: this.omittedAggregateObjects,
      stackSnapshotHistory: this.stackHistory.latestBatch,
      staticSnapshotHistory: this.staticHistory.latestBatch,
    };
  }

  materialize(checkpoint: MemoryViewerSnapshotCheckpoint | null): MemoryViewerSnapshotProjection {
    return {
      lifecycle: checkpoint?.lifecycle ?? null,
      activeScopes: materializeActiveScopes(checkpoint?.activeScopeTop ?? null),
      heapObjects: this.heapHistory.materialize(checkpoint?.heapSnapshotHistory ?? null),
      pointers: this.pointerHistory.materialize(checkpoint?.pointerSnapshotHistory ?? null),
      arrays: this.arrayHistory.materialize(checkpoint?.arraySnapshotHistory ?? null),
      omittedArrayObjects: checkpoint?.omittedArrayObjects ?? 0,
      aggregates: this.aggregateHistory.materialize(checkpoint?.aggregateSnapshotHistory ?? null),
      omittedAggregateObjects: checkpoint?.omittedAggregateObjects ?? 0,
      stackScalars: this.stackHistory.materialize(checkpoint?.stackSnapshotHistory ?? null),
      staticObjects: this.staticHistory.materialize(checkpoint?.staticSnapshotHistory ?? null),
    };
  }

  private acceptEvents(events: readonly DebugEvent[]): void {
    const freshEvents = events.filter(event => event.sequence > this.lastEventSequence);
    if (freshEvents.length === 0) return;
    this.lastEventSequence = freshEvents[freshEvents.length - 1].sequence;
    if (!this.usedHeap && freshEvents.some(event => event.kind === 'object-create' && event.duration === 'heap')) {
      this.usedHeap = true;
    }
    this.lifecycle = {
      previous: this.lifecycle,
      events: freshEvents,
      eventCount: (this.lifecycle?.eventCount ?? 0) + freshEvents.length,
    };
    // Lifecycle events are authoritative: frame-exit, errors, and limits do not imply scope exits.
    for (const event of freshEvents) {
      if (event.kind === 'scope-enter' && event.scopeId !== null) {
        const scope: MemoryViewerActiveScope = Object.freeze({
          id: event.scopeId,
          frameId: event.frameId,
          functionName: event.functionName,
          scopeName: event.scopeName,
          location: event.location,
        });
        this.activeScopeTop = { scope, previous: this.activeScopeTop };
      } else if (event.kind === 'scope-exit' && event.scopeId !== null) {
        this.activeScopeTop = removeActiveScope(this.activeScopeTop, event.scopeId);
      }
    }
  }
}

/** Materialize a selected persistent lifecycle prefix only when a consumer needs it. */
export function materializeMemoryViewerLifecycle(
  lifecycle: MemoryViewerLifecycleBatch | null,
): readonly DebugEvent[] {
  const batches: (readonly DebugEvent[])[] = [];
  for (let current = lifecycle; current; current = current.previous) batches.push(current.events);
  batches.reverse();
  return batches.flatMap(batch => batch);
}

function materializeActiveScopes(top: ActiveScopeNode | null): readonly MemoryViewerActiveScope[] {
  const scopes: MemoryViewerActiveScope[] = [];
  for (let node = top; node; node = node.previous) scopes.push(node.scope);
  scopes.reverse();
  return Object.freeze(scopes);
}

/** Remove one real scope while preserving any newer nodes if a journal is malformed. */
function removeActiveScope(top: ActiveScopeNode | null, scopeId: number): ActiveScopeNode | null {
  if (!top) return null;
  if (top.scope.id === scopeId) return top.previous;

  const newer: ActiveScopeNode[] = [];
  let node: ActiveScopeNode | null = top;
  while (node && node.scope.id !== scopeId) {
    newer.push(node);
    node = node.previous;
  }
  if (!node) return top;

  let result = node.previous;
  for (let index = newer.length - 1; index >= 0; index -= 1) {
    result = { scope: newer[index].scope, previous: result };
  }
  return result;
}
