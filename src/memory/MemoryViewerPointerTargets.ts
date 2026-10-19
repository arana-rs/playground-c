import type {
  DebugAggregateSnapshot,
  DebugHeapObjectSnapshot,
  DebugArraySnapshot,
  DebugPointerSnapshot,
  DebugStaticObjectSnapshot,
} from './useMemoryViewer.ts';
import type { MemoryRegion } from './MemoryViewerRegionModel.ts';
import { memoryViewerPointerIdentityKey } from './pointerSnapshots.ts';
import type { MemoryViewerPointerIdentity, MemoryViewerPointerTarget } from './pointerSnapshots.ts';

export function memoryViewerPointerTargetRegion(
  target: MemoryViewerPointerTarget,
  staticScalars: readonly DebugStaticObjectSnapshot[],
  heapObjects: readonly DebugHeapObjectSnapshot[],
  pointers: readonly DebugPointerSnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): MemoryRegion {
  if (target.kind === 'array-cell' || target.kind === 'aggregate-root' || target.kind === 'aggregate-field') return target.region;
  if (heapObjects.some(snapshot => snapshot.id === target.allocationId)
    || aggregates.some(snapshot => snapshot.rootId === target.allocationId && snapshot.region === 'heap')) return 'heap';
  return staticScalars.some(snapshot => snapshot.id === target.allocationId)
    || aggregates.some(snapshot => snapshot.rootId === target.allocationId && snapshot.region === 'static')
    || pointers.some(snapshot => snapshot.id === target.allocationId && snapshot.region === 'static')
    ? 'static'
    : 'stack';
}

export function expandMemoryViewerPointerTargetRegion(
  current: Record<MemoryRegion, boolean>,
  target: MemoryViewerPointerTarget,
  staticScalars: readonly DebugStaticObjectSnapshot[],
  heapObjects: readonly DebugHeapObjectSnapshot[],
  pointers: readonly DebugPointerSnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): Record<MemoryRegion, boolean> {
  const region = memoryViewerPointerTargetRegion(target, staticScalars, heapObjects, pointers, aggregates);
  return current[region] ? current : { ...current, [region]: true };
}

export function memoryViewerPointerInteractionTargetKey(
  pointerIdentity: MemoryViewerPointerIdentity,
  target: MemoryViewerPointerTarget,
): string {
  const identity = memoryViewerPointerIdentityKey(pointerIdentity);
  if (target.kind === 'array-cell') return `${identity}:array-cell:${target.allocationId}:${target.elementKey}`;
  if (target.kind === 'aggregate-field') return `${identity}:aggregate-field:${target.allocationId}:${target.fieldKey}`;
  if (target.kind === 'aggregate-root') return `${identity}:aggregate-root:${target.allocationId}`;
  return `${identity}:object:${target.allocationId}`;
}

export function hasMemoryViewerPointerIdentity(
  identity: MemoryViewerPointerIdentity,
  pointers: readonly DebugPointerSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
): boolean {
  if (identity.kind === 'object-pointer') return pointers.some(pointer => pointer.id === identity.id);
  if (identity.kind === 'array-element-pointer') return arrays.some(array => array.rootId === identity.rootId
    && array.elements.some(element => element.kind === 'pointer'
      && element.index === identity.index
      && element.key === `${identity.rootId}:${identity.index}`));
  return aggregates.some(aggregate => aggregate.rootId === identity.rootId
    && aggregate.members.some(member => member.key === identity.memberKey && member.kind === 'pointer'));
}
