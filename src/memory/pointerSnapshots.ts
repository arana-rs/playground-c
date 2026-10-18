import type {
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
} from '@playground/c11-engine/core';
import { hasAnonymousAggregateMember } from './aggregateSnapshots.ts';

type DebugScalarObjectSnapshot = DebugScalarSnapshot | DebugStaticObjectSnapshot;

export type MemoryViewerPointerIdentity =
  | { readonly kind: 'object-pointer'; readonly id: number }
  | { readonly kind: 'array-element-pointer'; readonly rootId: number; readonly index: number }
  | { readonly kind: 'aggregate-member-pointer'; readonly rootId: number; readonly memberKey: string };

export type MemoryViewerPointerTarget =
  | { readonly kind: 'object'; readonly allocationId: number }
  | {
    readonly kind: 'array-cell';
    readonly allocationId: number;
    readonly elementKey: string;
    readonly index: number;
    readonly region: DebugArraySnapshot['region'];
  }
  | {
    readonly kind: 'aggregate-root';
    readonly allocationId: number;
    readonly region: DebugAggregateSnapshot['region'];
  }
  | {
    readonly kind: 'aggregate-field';
    readonly allocationId: number;
    readonly fieldKey: string;
    readonly region: DebugAggregateSnapshot['region'];
  };

export function memoryViewerPointerIdentity(pointer: DebugPointerSnapshot): MemoryViewerPointerIdentity {
  return { kind: 'object-pointer', id: pointer.id };
}

export function memoryViewerArrayElementPointerIdentity(
  rootId: number,
  index: number,
): MemoryViewerPointerIdentity {
  return { kind: 'array-element-pointer', rootId, index };
}

export function memoryViewerAggregateMemberPointerIdentity(
  aggregate: DebugAggregateSnapshot,
  memberKey: string,
): MemoryViewerPointerIdentity {
  return { kind: 'aggregate-member-pointer', rootId: aggregate.rootId, memberKey };
}

export function memoryViewerPointerIdentityKey(identity: MemoryViewerPointerIdentity): string {
  return identity.kind === 'object-pointer'
    ? `pointer:${identity.id}`
    : identity.kind === 'array-element-pointer'
      ? `array-pointer:${identity.rootId}:${identity.index}`
      : `aggregate-pointer:${identity.rootId}:${identity.memberKey}`;
}

export function sameMemoryViewerPointerIdentity(
  left: MemoryViewerPointerIdentity | null,
  right: MemoryViewerPointerIdentity | null,
): boolean {
  return left === right || (left !== null && right !== null && memoryViewerPointerIdentityKey(left) === memoryViewerPointerIdentityKey(right));
}

function samePointerTarget(
  left: DebugPointerSnapshot['target'],
  right: DebugPointerSnapshot['target'],
): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.allocationId === right.allocationId
    && left.byteOffset === right.byteOffset
    && left.type === right.type
    && left.name === right.name);
}

/** Compare a pointer snapshot, including provenance used to resolve a live destination. */
export function sameMemoryViewerPointerSnapshot(
  left: DebugPointerSnapshot,
  right: DebugPointerSnapshot,
): boolean {
  return left.id === right.id
    && left.scopeId === right.scopeId
    && left.frameId === right.frameId
    && left.name === right.name
    && left.origin === right.origin
    && left.duration === right.duration
    && left.region === right.region
    && left.type === right.type
    && left.address === right.address
    && left.size === right.size
    && left.initialized === right.initialized
    && left.displayValue === right.displayValue
    && left.status === right.status
    && samePointerTarget(left.target, right.target);
}

/** Detach target provenance before retaining a Worker snapshot in persistent history. */
export function cloneMemoryViewerPointerSnapshot(snapshot: DebugPointerSnapshot): DebugPointerSnapshot {
  return Object.freeze({
    ...snapshot,
    ...(snapshot.target ? { target: Object.freeze({ ...snapshot.target }) } : {}),
  });
}

/** Return live pointers whose initialization, stored address, or pointer state changed. */
export function findMemoryViewerChangedPointerIds(
  previous: readonly DebugPointerSnapshot[],
  current: readonly DebugPointerSnapshot[],
): readonly number[] {
  const previousById = new Map(previous.map(pointer => [pointer.id, pointer]));
  return current.flatMap(pointer => {
    const earlier = previousById.get(pointer.id);
    return earlier && (earlier.initialized !== pointer.initialized
      || earlier.displayValue !== pointer.displayValue
      || earlier.status !== pointer.status)
      ? [pointer.id]
      : [];
  });
}

function parseExactAddress(address: string): bigint | null {
  if (!/^0x[\da-f]+$/i.test(address)) return null;
  try {
    return BigInt(address);
  } catch {
    return null;
  }
}

/** Resolve a selected live target by allocation identity, then exact byte offset and type. */
export function resolveMemoryViewerPointerTarget(
  hoveredPointer: number | MemoryViewerPointerIdentity | null,
  pointers: readonly DebugPointerSnapshot[],
  scalarSnapshots: readonly DebugScalarObjectSnapshot[],
  arrays: readonly DebugArraySnapshot[] = [],
  aggregates: readonly DebugAggregateSnapshot[] = [],
): MemoryViewerPointerTarget | null {
  if (hoveredPointer === null) return null;
  const identity = typeof hoveredPointer === 'number'
    ? { kind: 'object-pointer' as const, id: hoveredPointer }
    : hoveredPointer;
  const pointer = identity.kind === 'object-pointer'
    ? pointers.find(candidate => candidate.id === identity.id)
    : undefined;
  const arrayElementPointer = identity.kind === 'array-element-pointer'
    ? arrays.find(array => array.rootId === identity.rootId)
      ?.elements.find(element => element.index === identity.index
        && element.key === `${identity.rootId}:${identity.index}`
        && element.kind === 'pointer')
    : undefined;
  const aggregatePointer = identity.kind === 'aggregate-member-pointer'
    ? aggregates.find(aggregate => aggregate.rootId === identity.rootId)
      ?.members.find(member => member.key === identity.memberKey && member.kind === 'pointer')
    : undefined;
  const pointerStatus = pointer?.status ?? arrayElementPointer?.pointerStatus ?? aggregatePointer?.pointerStatus;
  const pointerInitialized = pointer?.initialized ?? arrayElementPointer?.initialized ?? aggregatePointer?.initialized;
  const target = pointer?.target ?? arrayElementPointer?.target ?? aggregatePointer?.target;
  if ((!pointer && !arrayElementPointer && !aggregatePointer) || pointerStatus !== 'live' || pointerInitialized !== true || !target
    || !Number.isSafeInteger(target.byteOffset) || target.byteOffset < 0) {
    return null;
  }

  const targetScalar = scalarSnapshots.find(snapshot => snapshot.id === target.allocationId);
  if (target.byteOffset === 0 && targetScalar?.type === target.type) {
    return { kind: 'object', allocationId: target.allocationId };
  }

  const targetPointer = pointers.find(snapshot => snapshot.id === target.allocationId);
  if (target.byteOffset === 0 && targetPointer?.type === target.type) {
    return { kind: 'object', allocationId: target.allocationId };
  }

  const targetArray = arrays.find(array => array.rootId === target.allocationId);
  if (targetArray && targetArray.status === 'available' && targetArray.elements.length === targetArray.length
    && targetArray.elementType === target.type && target.byteOffset < targetArray.size) {
    const rootAddress = parseExactAddress(targetArray.address);
    if (rootAddress !== null) {
      const byteOffset = BigInt(target.byteOffset);
      const targetAddress = rootAddress + byteOffset;
      const cell = targetArray.elements.find(element => {
        if (element.type !== target.type || !Number.isInteger(element.index)
          || element.index < 0 || element.index >= targetArray.length
          || element.key !== `${targetArray.rootId}:${element.index}`) return false;
        const cellAddress = parseExactAddress(element.address);
        return cellAddress !== null && cellAddress - rootAddress === byteOffset && cellAddress === targetAddress;
      });
      if (cell) {
        return {
          kind: 'array-cell',
          allocationId: targetArray.rootId,
          elementKey: cell.key,
          index: cell.index,
          region: targetArray.region,
        };
      }
    }
  }

  const targetAggregate = aggregates.find(aggregate => aggregate.rootId === target.allocationId);
  if (!targetAggregate || target.byteOffset >= targetAggregate.size) return null;
  const rootAddress = parseExactAddress(targetAggregate.address);
  if (rootAddress === null) return null;
  if (target.byteOffset === 0 && targetAggregate.type === target.type) {
    return {
      kind: 'aggregate-root',
      allocationId: targetAggregate.rootId,
      region: targetAggregate.region,
    };
  }
  const targetAddress = rootAddress + BigInt(target.byteOffset);
  const member = targetAggregate.status === 'available' && !hasAnonymousAggregateMember(targetAggregate)
    ? targetAggregate.members.find(candidate => candidate.kind === 'arithmetic'
    && candidate.offset === target.byteOffset
    && candidate.type === target.type
    && parseExactAddress(candidate.address) === targetAddress)
    : undefined;
  if (!member) return null;
  return {
    kind: 'aggregate-field',
    allocationId: targetAggregate.rootId,
    fieldKey: member.key,
    region: targetAggregate.region,
  };
}

/** Compatibility helper for callers that need the existing root-object link only. */
export function resolveMemoryViewerPointerTargetId(
  hoveredPointerId: number | null,
  pointers: readonly DebugPointerSnapshot[],
  scalarSnapshots: readonly DebugScalarObjectSnapshot[],
): number | null {
  const target = resolveMemoryViewerPointerTarget(hoveredPointerId, pointers, scalarSnapshots);
  return target?.kind === 'object' ? target.allocationId : null;
}
