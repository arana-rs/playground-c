import type {
  DebugEvent,
  DebugProgress,
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugSourceLocation,
  DebugStaticObjectSnapshot,
} from '@playground/c11-engine/core';

export type MemoryViewerCommand =
  | { type: 'debug-start'; jobId: number; fileName: string; source: string }
  | { type: 'debug-step'; jobId: number; requestId: number };

export type MemoryViewerResponse =
  | {
    type: 'debug-ready'; jobId: number; location: DebugSourceLocation;
    hasHeapAllocationCalls: boolean;
    events: readonly DebugEvent[];
    heapObjects: readonly DebugHeapObjectSnapshot[];
    pointers: readonly DebugPointerSnapshot[];
    arrays: readonly DebugArraySnapshot[];
    omittedArrayObjects: number;
    aggregates: readonly DebugAggregateSnapshot[];
    omittedAggregateObjects: number;
    stackScalars: readonly DebugScalarSnapshot[];
    staticObjects: readonly DebugStaticObjectSnapshot[];
  }
  | {
    type: 'debug-progress'; jobId: number; requestId: number | null;
    progress: DebugProgress;
    events: readonly DebugEvent[];
    heapObjects: readonly DebugHeapObjectSnapshot[];
    pointers: readonly DebugPointerSnapshot[];
    arrays: readonly DebugArraySnapshot[];
    omittedArrayObjects: number;
    aggregates: readonly DebugAggregateSnapshot[];
    omittedAggregateObjects: number;
    stackScalars: readonly DebugScalarSnapshot[];
    staticObjects: readonly DebugStaticObjectSnapshot[];
  }
  | { type: 'debug-error'; jobId: number; requestId: number | null; status: 'error' | 'limit'; message: string };
