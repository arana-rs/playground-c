import type { DebugAggregateSnapshot } from '@playground/c11-engine/core';
import { sameArrayElement } from './arraySnapshots.ts';

type DebugAggregateMemberSnapshot = DebugAggregateSnapshot['members'][number];

/** Compare a bounded aggregate DTO, including visible member values and padding extents. */
export function sameMemoryViewerAggregateSnapshot(
  left: DebugAggregateSnapshot,
  right: DebugAggregateSnapshot,
): boolean {
  return left.rootId === right.rootId
    && left.viewId === right.viewId
    && left.name === right.name
    && left.origin === right.origin
    && left.duration === right.duration
    && left.region === right.region
    && left.frameId === right.frameId
    && left.scopeId === right.scopeId
    && left.type === right.type
    && left.kind === right.kind
    && left.address === right.address
    && left.size === right.size
    && left.readOnly === right.readOnly
    && left.memberCount === right.memberCount
    && left.status === right.status
    && left.members.length === right.members.length
    && left.members.every((member, index) => sameMember(member, right.members[index]!))
    && left.padding.length === right.padding.length
    && left.padding.every((span, index) => {
      const other = right.padding[index]!;
      return span.key === other.key && span.offset === other.offset && span.size === other.size;
    });
}

function sameTarget(
  left: DebugAggregateMemberSnapshot['target'],
  right: DebugAggregateMemberSnapshot['target'],
): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.allocationId === right.allocationId
    && left.byteOffset === right.byteOffset
    && left.type === right.type
    && left.name === right.name);
}

function sameMember(left: DebugAggregateMemberSnapshot, right: DebugAggregateMemberSnapshot): boolean {
  return left.key === right.key
    && left.index === right.index
    && left.name === right.name
    && left.type === right.type
    && left.kind === right.kind
    && left.offset === right.offset
    && left.size === right.size
    && left.bitWidth === right.bitWidth
    && left.bitOffset === right.bitOffset
    && left.storageUnitSize === right.storageUnitSize
    && sameFlexibleArray(left.flexibleArray, right.flexibleArray)
    && left.address === right.address
    && left.initialized === right.initialized
    && left.displayValue === right.displayValue
    && left.pointerStatus === right.pointerStatus
    && left.unsupportedReason === right.unsupportedReason
    && sameTarget(left.target, right.target);
}

function sameFlexibleArray(
  left: DebugAggregateMemberSnapshot['flexibleArray'],
  right: DebugAggregateMemberSnapshot['flexibleArray'],
): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.elementSize === right.elementSize
    && left.capacityBytes === right.capacityBytes
    && left.length === right.length
    && left.status === right.status
    && left.omittedElements === right.omittedElements
    && left.elements.length === right.elements.length
    && left.elements.every((element, index) => sameArrayElement(element, right.elements[index]!)));
}

/** Detach nested member values, target provenance, FAM cells, and padding before retaining a Worker snapshot. */
export function cloneMemoryViewerAggregateSnapshot(snapshot: DebugAggregateSnapshot): DebugAggregateSnapshot {
  const members = Object.freeze(snapshot.members.map(member => Object.freeze({
    ...member,
    ...(member.target ? { target: Object.freeze({ ...member.target }) } : {}),
    ...(member.flexibleArray ? {
      flexibleArray: Object.freeze({
        ...member.flexibleArray,
        elements: Object.freeze(member.flexibleArray.elements.map(element => Object.freeze({ ...element }))),
      }),
    } : {}),
  })));
  const padding = Object.freeze(snapshot.padding.map(span => Object.freeze({ ...span })));
  return Object.freeze({ ...snapshot, members, padding });
}

/** Find live aggregate fields whose initialization or displayed value changed. */
export function findMemoryViewerChangedAggregateMemberKeys(
  previous: readonly DebugAggregateSnapshot[],
  current: readonly DebugAggregateSnapshot[],
): readonly string[] {
  const previousByKey = new Map<string, DebugAggregateMemberSnapshot>();
  for (const aggregate of previous) {
    for (const member of aggregate.members) previousByKey.set(member.key, member);
  }

  return current.flatMap(aggregate => aggregate.members.flatMap(member => {
    const earlier = previousByKey.get(member.key);
    return earlier && (earlier.initialized !== member.initialized
      || earlier.displayValue !== member.displayValue
      || earlier.pointerStatus !== member.pointerStatus
      || !sameFlexibleArray(earlier.flexibleArray, member.flexibleArray)
      || !sameTarget(earlier.target, member.target))
      ? [member.key]
      : [];
  }));
}
