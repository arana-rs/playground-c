import type {
  DebugEvent,
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
  DebugScalarSnapshot,
  DebugSourceLocation,
  DebugStaticObjectSnapshot,
} from '@playground/c11-engine/core';
import { RUN_CONFIGURATION } from '../execution/configuration.ts';
import type { RunConfiguration } from '../execution/configuration.ts';

export const MEMORY_VIEWER_PLAY_INTERVAL_MS = RUN_CONFIGURATION.memoryViewer.playIntervalMs;
export const MEMORY_VIEWER_HISTORY_LIMIT = RUN_CONFIGURATION.memoryViewer.historySteps;

export type MemoryViewerStatus = 'starting' | 'paused' | 'running' | 'waiting-input' | 'terminated' | 'cancelled' | 'error' | 'limit';

export interface MemoryViewerTranscriptEntry {
  readonly stream: 'stdout' | 'stderr' | 'stdin' | 'system';
  readonly text: string;
  readonly tone?: 'system' | 'warning' | 'error';
  readonly role?: 'input' | 'protected';
}

/** Immutable, persistent batches let later UI replay lifecycle events without copying each prefix. */
export interface MemoryViewerLifecycleBatch {
  readonly previous: MemoryViewerLifecycleBatch | null;
  readonly events: readonly DebugEvent[];
  readonly eventCount: number;
}

/** A real active C scope, identified by the engine's dynamic scope ID. */
export interface MemoryViewerActiveScope {
  readonly id: number;
  readonly frameId: number | null;
  readonly functionName: string;
  readonly scopeName: string;
  readonly location: DebugSourceLocation;
}

export interface MemoryViewerState {
  /** Source captured when the viewer mounted. */
  readonly source: string;
  readonly location: DebugSourceLocation | null;
  readonly status: MemoryViewerStatus;
  readonly isPlaying: boolean;
  /**
   * Console transcript projected through the selected history point. At the live frontier, this array
   * may be updated in place; consumers that memoize its contents must also observe transcriptRevision.
   */
  readonly transcript: readonly MemoryViewerTranscriptEntry[];
  /** Changes when the visible transcript changes, including an in-place live-tail update. */
  readonly transcriptRevision: number;
  /** Token for the currently displayed input wait, hidden while browsing cached history. */
  readonly inputRequestId: number | null;
  readonly isViewingHistory: boolean;
  /** Whether Stop can cancel a live VM, including while a cached history entry is selected. */
  readonly canStop: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  /** Zero-based VM line-step index; remains monotonic after old history is pruned. */
  readonly stepIndex: number;
  readonly errorMessage: string | null;
  readonly historyNotice: number | null;
  /** True after this debug session has accepted its first real heap allocation event. */
  readonly hasUsedHeap: boolean;
  /** True when preparation found a resolved supported heap allocator call anywhere in the program. */
  readonly hasHeapAllocationCalls: boolean;
  /** Event journal as-of this displayed history point. It contains no C values. */
  readonly lifecycle: MemoryViewerLifecycleBatch | null;
  /** Active scopes at the selected history point, ordered oldest to newest. */
  readonly activeScopes: readonly MemoryViewerActiveScope[];
  /** Live heap allocations at the selected history point. */
  readonly heapObjects: readonly DebugHeapObjectSnapshot[];
  /** Live automatic and static pointer objects at the selected history point. */
  readonly pointers: readonly DebugPointerSnapshot[];
  /** Bounded one-dimensional arrays and string literals at the selected history point. */
  readonly arrays: readonly DebugArraySnapshot[];
  readonly omittedArrayObjects: number;
  /** Bounded struct descriptors and visible member values at the selected history point. */
  readonly aggregates: readonly DebugAggregateSnapshot[];
  readonly omittedAggregateObjects: number;
  /** Live automatic scalar objects at the selected history point, in engine DTO format. */
  readonly stackScalars: readonly DebugScalarSnapshot[];
  /** Live static scalars and string literals at the selected history point. */
  readonly staticObjects: readonly DebugStaticObjectSnapshot[];
}

export interface MemoryViewerControllerOptions {
  readonly configuration?: RunConfiguration;
  readonly workerFactory?: () => Worker;
  readonly maxHistoryEntries?: number;
  readonly playbackIntervalMs?: number;
  /** Whether this session should capture and publish console I/O. */
  readonly enableConsole?: boolean;
  readonly timers?: {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}
