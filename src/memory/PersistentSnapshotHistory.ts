export interface PersistentSnapshotBatch<T extends object> {
  readonly previous: PersistentSnapshotBatch<T> | null;
  readonly changes: readonly SnapshotChange<T>[];
  /** New display order only when it changes; a checkpoint always includes it. */
  readonly orderIds: readonly number[] | null;
}

interface SnapshotChange<T extends object> {
  readonly id: number;
  readonly snapshot: T | null;
}

export interface PersistentSnapshotHistoryOptions<T extends object> {
  /** Read the stable allocation identity used to share/replay snapshots. */
  readonly getId?: (snapshot: T) => number;
  /** Compare the full immutable value while preserving sharing for unchanged snapshots. */
  readonly sameSnapshot?: (left: T, right: T) => boolean;
  /** Copy nested DTOs before retaining snapshots received from a Worker. */
  readonly cloneSnapshot?: (snapshot: T) => T;
}

const EMPTY_ORDER: readonly number[] = Object.freeze([]);
const EMPTY_SNAPSHOTS: readonly { readonly id: number }[] = Object.freeze([]);

function sameSnapshot<T extends object>(left: T, right: T): boolean {
  const leftKeys = Object.keys(left) as (keyof T)[];
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => left[key] === right[key]);
}

function defaultSnapshotId<T extends object>(snapshot: T): number {
  return (snapshot as { readonly id: number }).id;
}

function sameOrder(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Persistent delta history shared by the viewer's automatic and static snapshots. */
export class PersistentSnapshotHistory<T extends object> {
  private readonly checkpointInterval: number;
  private readonly getId: (snapshot: T) => number;
  private readonly sameSnapshot: (left: T, right: T) => boolean;
  private readonly cloneSnapshot: (snapshot: T) => T;
  private latestById = new Map<number, T>();
  private latestOrder: readonly number[] = EMPTY_ORDER;
  private batch: PersistentSnapshotBatch<T> | null = null;
  private batchesSinceCheckpoint = 0;
  private materializedBatch: PersistentSnapshotBatch<T> | null = null;
  private materializedSnapshots: readonly T[] = EMPTY_SNAPSHOTS as readonly T[];

  constructor(checkpointInterval = 128, options: PersistentSnapshotHistoryOptions<T> = {}) {
    this.checkpointInterval = Math.max(1, checkpointInterval);
    this.getId = options.getId ?? defaultSnapshotId;
    this.sameSnapshot = options.sameSnapshot ?? sameSnapshot;
    this.cloneSnapshot = options.cloneSnapshot ?? (snapshot => Object.freeze({ ...snapshot }) as T);
  }

  get latestBatch(): PersistentSnapshotBatch<T> | null { return this.batch; }

  reset(): void {
    this.latestById = new Map();
    this.latestOrder = EMPTY_ORDER;
    this.batch = null;
    this.batchesSinceCheckpoint = 0;
    this.materializedBatch = null;
    this.materializedSnapshots = EMPTY_SNAPSHOTS as readonly T[];
  }

  /** Copy immutable DTOs from the Worker and append only actual changes. */
  accept(snapshot: readonly T[] | undefined): void {
    if (!snapshot) return;

    const nextById = new Map<number, T>();
    const nextOrder = snapshot.map(item => this.getId(item));
    const changes: SnapshotChange<T>[] = [];
    for (const item of snapshot) {
      const id = this.getId(item);
      const previous = this.latestById.get(id);
      const current = previous && this.sameSnapshot(previous, item)
        ? previous
        : this.cloneSnapshot(item);
      nextById.set(id, current);
      if (current !== previous) changes.push(Object.freeze({ id, snapshot: current }));
    }
    for (const [id] of this.latestById) {
      if (!nextById.has(id)) changes.push(Object.freeze({ id, snapshot: null }));
    }

    const orderChanged = !sameOrder(this.latestOrder, nextOrder);
    this.latestById = nextById;
    if (changes.length === 0 && !orderChanged) return;

    if (this.batch === null || this.batchesSinceCheckpoint + 1 >= this.checkpointInterval) {
      this.batch = Object.freeze({
        previous: null,
        changes: Object.freeze([...nextById.entries()].map(([id, item]) => Object.freeze({ id, snapshot: item }))),
        orderIds: Object.freeze(nextOrder),
      });
      this.latestOrder = Object.freeze(nextOrder);
      this.batchesSinceCheckpoint = 0;
      return;
    }

    const orderIds = orderChanged ? Object.freeze(nextOrder) : null;
    this.batch = Object.freeze({
      previous: this.batch,
      changes: Object.freeze(changes),
      orderIds,
    });
    if (orderIds) this.latestOrder = orderIds;
    this.batchesSinceCheckpoint += 1;
  }

  /** Reconstruct only the selected history point and cache that materialized result. */
  materialize(batch: PersistentSnapshotBatch<T> | null): readonly T[] {
    if (batch === this.materializedBatch) return this.materializedSnapshots;
    if (!batch) {
      this.materializedBatch = null;
      this.materializedSnapshots = EMPTY_SNAPSHOTS as readonly T[];
      return this.materializedSnapshots;
    }

    const batches: PersistentSnapshotBatch<T>[] = [];
    for (let current: PersistentSnapshotBatch<T> | null = batch; current; current = current.previous) {
      batches.push(current);
    }
    batches.reverse();

    const values = new Map<number, T>();
    let orderIds: readonly number[] = EMPTY_ORDER;
    for (const current of batches) {
      for (const change of current.changes) {
        if (change.snapshot) values.set(change.id, change.snapshot);
        else values.delete(change.id);
      }
      if (current.orderIds) orderIds = current.orderIds;
    }

    this.materializedBatch = batch;
    this.materializedSnapshots = Object.freeze(orderIds.flatMap(id => {
      const item = values.get(id);
      return item ? [item] : [];
    }));
    return this.materializedSnapshots;
  }
}
