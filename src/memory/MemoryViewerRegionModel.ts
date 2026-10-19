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
  readonly phase: 'waiting' | 'fading';
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
