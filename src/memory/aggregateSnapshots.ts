import type { DebugAggregateSnapshot } from '@playground/c11-engine/core';

type DebugAggregateMemberSnapshot = DebugAggregateSnapshot['members'][number];

/** Compare a bounded aggregate DTO, including visible member values and padding extents. */
export function sameMemoryViewerAggregateSnapshot(
  left: DebugAggregateSnapshot,
  right: DebugAggregateSnapshot,
): boolean {
  return left.rootId === right.rootId
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
    && left.address === right.address
    && left.initialized === right.initialized
    && left.displayValue === right.displayValue
    && left.pointerStatus === right.pointerStatus
    && left.unsupportedReason === right.unsupportedReason
    && sameTarget(left.target, right.target);
}

/** Detach nested member values, target provenance, and padding before retaining a Worker snapshot. */
export function cloneMemoryViewerAggregateSnapshot(snapshot: DebugAggregateSnapshot): DebugAggregateSnapshot {
  const members = Object.freeze(snapshot.members.map(member => Object.freeze({
    ...member,
    ...(member.target ? { target: Object.freeze({ ...member.target }) } : {}),
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
      || !sameTarget(earlier.target, member.target))
      ? [member.key]
      : [];
  }));
}
