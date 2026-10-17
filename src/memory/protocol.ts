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
  | { type: 'debug-step'; jobId: number; requestId: number }
  | { type: 'debug-stdin'; jobId: number; requestId: number; inputRequestId: number; bytes: Uint8Array }
  | { type: 'debug-stdin-eof'; jobId: number; requestId: number; inputRequestId: number };

/** Paused/waiting progress moves output through debug-output deltas, not cumulative byte snapshots. */
export type MemoryViewerProgress = DebugProgress extends infer Result
  ? Result extends { kind: 'paused' | 'input-needed' }
    ? Omit<Result, 'stdout' | 'stderr'>
    : Result
  : never;

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
    /** Sequence follows emitted deltas; byte order is preserved per stream, not globally across stdout/stderr. */
    type: 'debug-output'; jobId: number; requestId: number | null;
    sequence: number; stream: 'stdout' | 'stderr'; chunk: Uint8Array;
  }
  | {
    type: 'debug-progress'; jobId: number; requestId: number | null;
    /** Unique per wait; the debug-step requestId remains unchanged across repeated waits. */
    inputRequestId?: number;
    progress: MemoryViewerProgress;
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
