import type {
  DebugAggregateSnapshot,
  DebugHeapObjectSnapshot,
  DebugArraySnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
  MemoryViewerActiveScope,
  MemoryViewerLifecycleBatch,
} from './useMemoryViewer.ts';
import type { useMemoryViewer } from './useMemoryViewer.ts';

export type MemoryRegion = 'static' | 'stack' | 'heap';
export const MEMORY_VIEWER_MODES = [
  { value: 'minimal' },
  { value: 'normal' },
  { value: 'debug' },
] as const;
export type MemoryViewerMode = (typeof MEMORY_VIEWER_MODES)[number]['value'];

export interface MemoryViewerRegionsProps {
  mode: MemoryViewerMode;
  hasUsedHeap: boolean;
  hasHeapAllocationCalls: boolean;
  lifecycle: MemoryViewerLifecycleBatch | null;
  activeScopes: readonly MemoryViewerActiveScope[];
  heapObjects: readonly DebugHeapObjectSnapshot[];
  arrays: readonly DebugArraySnapshot[];
  omittedArrayObjects: number;
  aggregates: readonly DebugAggregateSnapshot[];
  omittedAggregateObjects: number;
  stackScalars: readonly DebugScalarSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  staticObjects: readonly DebugStaticObjectSnapshot[];
  stepIndex: number;
  status: ReturnType<typeof useMemoryViewer>['status'];
}

export type MemoryViewerStackObject =
  | { readonly id: number; readonly kind: 'scalar'; readonly snapshot: DebugScalarSnapshot }
  | { readonly id: number; readonly kind: 'pointer'; readonly snapshot: DebugPointerSnapshot }
  | { readonly id: number; readonly kind: 'array'; readonly snapshot: DebugArraySnapshot }
  | { readonly id: number; readonly kind: 'aggregate'; readonly snapshot: DebugAggregateSnapshot };

export type MemoryViewerStaticObject =
  | { readonly id: number; readonly kind: 'scalar'; readonly snapshot: DebugStaticObjectSnapshot }
  | { readonly id: number; readonly kind: 'pointer'; readonly snapshot: DebugPointerSnapshot }
  | { readonly id: number; readonly kind: 'array'; readonly snapshot: DebugArraySnapshot }
  | { readonly id: number; readonly kind: 'aggregate'; readonly snapshot: DebugAggregateSnapshot };

export function stackMemoryObjects(
  scalars: readonly DebugScalarSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  pointers: readonly DebugPointerSnapshot[] = [],
  aggregates: readonly DebugAggregateSnapshot[] = [],
): MemoryViewerStackObject[] {
  return [
    ...scalars.map(snapshot => ({ id: snapshot.id, kind: 'scalar' as const, snapshot })),
    ...pointers.filter(snapshot => snapshot.region === 'stack').map(snapshot => ({ id: snapshot.id, kind: 'pointer' as const, snapshot })),
    ...arrays.map(snapshot => ({ id: snapshot.rootId, kind: 'array' as const, snapshot })),
    ...aggregates.filter(snapshot => snapshot.region === 'stack').map(snapshot => ({ id: snapshot.viewId ?? snapshot.rootId, kind: 'aggregate' as const, snapshot })),
  ].sort((left, right) => left.id - right.id);
}

export function staticMemoryObjects(
  scalars: readonly DebugStaticObjectSnapshot[],
  arrays: readonly DebugArraySnapshot[],
  pointers: readonly DebugPointerSnapshot[] = [],
  aggregates: readonly DebugAggregateSnapshot[] = [],
): MemoryViewerStaticObject[] {
  return [
    ...scalars.map(snapshot => ({ id: snapshot.id, kind: 'scalar' as const, snapshot })),
    ...pointers.filter(snapshot => snapshot.region === 'static').map(snapshot => ({ id: snapshot.id, kind: 'pointer' as const, snapshot })),
    ...arrays.map(snapshot => ({ id: snapshot.rootId, kind: 'array' as const, snapshot })),
    ...aggregates.filter(snapshot => snapshot.region === 'static').map(snapshot => ({ id: snapshot.viewId ?? snapshot.rootId, kind: 'aggregate' as const, snapshot })),
  ].sort((left, right) => left.id - right.id);
}

export interface MemoryViewerExitPresentation {
  readonly stepIndex: number;
  readonly deletedScalars: readonly DebugScalarSnapshot[];
  readonly deletedPointers: readonly DebugPointerSnapshot[];
  readonly deletedArrays: readonly DebugArraySnapshot[];
  readonly deletedAggregates: readonly DebugAggregateSnapshot[];
  readonly exitedScopes: readonly MemoryViewerActiveScope[];
  readonly previousStackObjectIds: readonly number[];
  readonly previousScopeIds: readonly number[];
  readonly focusId: number | null;
  readonly phase: 'waiting' | 'fading';
}

export interface MemoryViewerHeapExitPresentation {
  readonly stepIndex: number;
  readonly deletedObjects: readonly DebugHeapObjectSnapshot[];
  readonly previousObjectIds: readonly number[];
  readonly focusId: number | null;
  readonly completedObjectId: number | null;
  readonly phase: 'waiting' | 'fading' | 'complete';
}

export function createMemoryViewerHeapExitPresentation(
  stepIndex: number,
  releasedObject: DebugHeapObjectSnapshot,
  previousObjects: readonly DebugHeapObjectSnapshot[],
): MemoryViewerHeapExitPresentation {
  return {
    stepIndex,
    deletedObjects: [releasedObject],
    previousObjectIds: previousObjects.map(object => object.id),
    focusId: releasedObject.id,
    completedObjectId: null,
    phase: 'waiting',
  };
}

export function resolveMemoryViewerHeapExitPresentation(
  presentation: MemoryViewerHeapExitPresentation,
  previousRelease: DebugHeapObjectSnapshot | null,
  currentRelease: DebugHeapObjectSnapshot | null,
  stepIndex: number,
  previousObjects: readonly DebugHeapObjectSnapshot[],
  fallbackRelease: DebugHeapObjectSnapshot | null = null,
): MemoryViewerHeapExitPresentation {
  if (previousRelease?.id !== currentRelease?.id) {
    if (currentRelease) return createMemoryViewerHeapExitPresentation(stepIndex, currentRelease, previousObjects);
    if (previousRelease && shouldDisplayMemoryViewerFreedHeapObject(previousRelease, presentation)) {
      return {
        ...createMemoryViewerHeapExitPresentation(stepIndex, previousRelease, previousObjects),
        phase: 'fading',
      };
    }
    return presentation.phase === 'fading'
      && previousRelease !== null
      && memoryViewerHeapPresentationHasObject(presentation, previousRelease.id)
      ? presentation
      : EMPTY_HEAP_EXIT_PRESENTATION;
  }
  if (currentRelease) {
    return memoryViewerHeapPresentationHasObject(presentation, currentRelease.id)
      ? presentation
      : createMemoryViewerHeapExitPresentation(stepIndex, currentRelease, previousObjects);
  }
  return fallbackRelease
    ? createMemoryViewerHeapExitPresentation(stepIndex, fallbackRelease, previousObjects)
    : EMPTY_HEAP_EXIT_PRESENTATION;
}

export function completeMemoryViewerHeapExitPresentation(
  presentation: MemoryViewerHeapExitPresentation,
): MemoryViewerHeapExitPresentation {
  if (presentation.phase === 'complete') return presentation;
  return {
    ...EMPTY_HEAP_EXIT_PRESENTATION,
    stepIndex: presentation.stepIndex,
    completedObjectId: presentation.deletedObjects.at(-1)?.id ?? presentation.completedObjectId,
    phase: 'complete',
  };
}

function memoryViewerHeapPresentationHasObject(
  presentation: MemoryViewerHeapExitPresentation,
  objectId: number,
): boolean {
  return presentation.completedObjectId === objectId
    || presentation.deletedObjects.some(object => object.id === objectId);
}

export function shouldDisplayMemoryViewerFreedHeapObject(
  releasedObject: DebugHeapObjectSnapshot | null,
  presentation: MemoryViewerHeapExitPresentation,
): boolean {
  if (!releasedObject) return false;
  if (!memoryViewerHeapPresentationHasObject(presentation, releasedObject.id)) return true;
  return presentation.phase === 'waiting';
}

export function isMemoryViewerHeapEmpty(
  heapObjects: readonly DebugHeapObjectSnapshot[],
  aggregates: readonly DebugAggregateSnapshot[],
  releasedObject: DebugHeapObjectSnapshot | null,
  presentation: MemoryViewerHeapExitPresentation,
): boolean {
  const releaseHasFinished = releasedObject === null
    ? presentation.deletedObjects.length === 0 || presentation.phase === 'complete'
    : memoryViewerHeapPresentationHasObject(presentation, releasedObject.id)
      && presentation.phase === 'complete';
  return heapObjects.length === 0
    && !aggregates.some(aggregate => aggregate.region === 'heap')
    && releaseHasFinished;
}

export interface MemoryViewerValueChangePresentation {
  readonly stepIndex: number;
  readonly stackScalarIds: readonly number[];
  readonly stackPointerIds: readonly number[];
  readonly staticObjectIds: readonly number[];
  readonly staticPointerIds: readonly number[];
  readonly arrayElementKeys: readonly string[];
  readonly aggregateMemberKeys: readonly string[];
}

export const EMPTY_EXIT_PRESENTATION: MemoryViewerExitPresentation = {
  stepIndex: -1,
  deletedScalars: [],
  deletedPointers: [],
  deletedArrays: [],
  deletedAggregates: [],
  exitedScopes: [],
  previousStackObjectIds: [],
  previousScopeIds: [],
  focusId: null,
  phase: 'waiting',
};

export const EMPTY_HEAP_EXIT_PRESENTATION: MemoryViewerHeapExitPresentation = {
  stepIndex: -1,
  deletedObjects: [],
  previousObjectIds: [],
  focusId: null,
  completedObjectId: null,
  phase: 'waiting',
};

export const EMPTY_VALUE_CHANGE_PRESENTATION: MemoryViewerValueChangePresentation = {
  stepIndex: -1,
  stackScalarIds: [],
  stackPointerIds: [],
  staticObjectIds: [],
  staticPointerIds: [],
  arrayElementKeys: [],
  aggregateMemberKeys: [],
};
