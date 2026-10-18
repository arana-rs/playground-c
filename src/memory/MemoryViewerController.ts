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
import type { MemoryViewerCommand, MemoryViewerProgress, MemoryViewerResponse } from './protocol.ts';
import { PersistentSnapshotHistory } from './PersistentSnapshotHistory.ts';
import type { PersistentSnapshotBatch } from './PersistentSnapshotHistory.ts';
import { cloneMemoryViewerArraySnapshot, sameMemoryViewerArraySnapshot } from './arraySnapshots.ts';
import { cloneMemoryViewerAggregateSnapshot, sameMemoryViewerAggregateSnapshot } from './aggregateSnapshots.ts';
import { cloneMemoryViewerPointerSnapshot, sameMemoryViewerPointerSnapshot } from './pointerSnapshots.ts';
import { isMemoryViewerPlaybackInterval } from './playbackSpeed.ts';

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

interface HistoryEntry {
  readonly location: DebugSourceLocation | null;
  readonly status: MemoryViewerStatus;
  readonly errorMessage: string | null;
  readonly lifecycle: MemoryViewerLifecycleBatch | null;
  readonly activeScopeTop: ActiveScopeNode | null;
  readonly heapSnapshotHistory: PersistentSnapshotBatch<DebugHeapObjectSnapshot> | null;
  readonly pointerSnapshotHistory: PersistentSnapshotBatch<DebugPointerSnapshot> | null;
  readonly arraySnapshotHistory: PersistentSnapshotBatch<DebugArraySnapshot> | null;
  readonly omittedArrayObjects: number;
  readonly aggregateSnapshotHistory: PersistentSnapshotBatch<DebugAggregateSnapshot> | null;
  readonly omittedAggregateObjects: number;
  readonly stackSnapshotHistory: PersistentSnapshotBatch<DebugScalarSnapshot> | null;
  readonly staticSnapshotHistory: PersistentSnapshotBatch<DebugStaticObjectSnapshot> | null;
  readonly consoleCheckpoint: ConsoleCheckpoint;
  readonly transcriptRevision: number;
}

interface ConsoleCheckpoint {
  /** Number of transcript runs at this point. */
  readonly segmentCount: number;
  /** Length of the last run, which may later grow by coalescing adjacent output chunks. */
  readonly tailLength: number;
}

const EMPTY_CONSOLE_CHECKPOINT: ConsoleCheckpoint = Object.freeze({ segmentCount: 0, tailLength: 0 });

interface ActiveScopeNode {
  readonly scope: MemoryViewerActiveScope;
  readonly previous: ActiveScopeNode | null;
}

interface ActiveWorker {
  readonly worker: Worker;
  readonly jobId: number;
}

function createWorker(): Worker {
  return new Worker(new URL('./memory.worker.ts', import.meta.url), { type: 'module' });
}

function diagnosticMessage(progress: Exclude<MemoryViewerProgress, { kind: 'paused' }>): string | null {
  if (!('diagnostics' in progress) || progress.diagnostics.length === 0) return null;
  return progress.diagnostics
    .map(item => `${item.file}:${item.line}:${item.column}: ${item.message}`)
    .join('\n');
}

function statusForProgress(progress: MemoryViewerProgress): MemoryViewerStatus {
  if (progress.kind === 'paused') return 'paused';
  if (progress.kind === 'input-needed') return 'waiting-input';
  if (progress.kind === 'terminated') return 'terminated';
  if (progress.kind === 'limit' || progress.kind === 'debug-limit') return 'limit';
  return 'error';
}

function defaultTimers() {
  return {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
}

function materializeActiveScopes(top: ActiveScopeNode | null): readonly MemoryViewerActiveScope[] {
  const scopes: MemoryViewerActiveScope[] = [];
  for (let node = top; node; node = node.previous) scopes.push(node.scope);
  scopes.reverse();
  return Object.freeze(scopes);
}

/** Remove one real scope while preserving any newer nodes if a journal is malformed. */
function removeActiveScope(top: ActiveScopeNode | null, scopeId: number): ActiveScopeNode | null {
  if (!top) return null;
  if (top.scope.id === scopeId) return top.previous;

  const newer: ActiveScopeNode[] = [];
  let node: ActiveScopeNode | null = top;
  while (node && node.scope.id !== scopeId) {
    newer.push(node);
    node = node.previous;
  }
  if (!node) return top;

  let result = node.previous;
  for (let index = newer.length - 1; index >= 0; index -= 1) {
    result = { scope: newer[index].scope, previous: result };
  }
  return result;
}

/** Owns a single debug Worker and a bounded cursor over already-produced VM steps. */
export class MemoryViewerController {
  private readonly configuration: RunConfiguration;
  private readonly workerFactory: () => Worker;
  private readonly maxHistoryEntries: number;
  private playbackIntervalMs: number;
  private readonly timers: NonNullable<MemoryViewerControllerOptions['timers']>;
  private readonly listeners = new Set<(state: MemoryViewerState) => void>();
  private active: ActiveWorker | null = null;
  private nextJobId = 0;
  private nextRequestId = 0;
  private pendingStart = false;
  private pendingRequestId: number | null = null;
  private pendingOriginStep: number | null = null;
  private pendingOriginLocation: DebugSourceLocation | null = null;
  private pendingInputLocation: DebugSourceLocation | null = null;
  private inputRequestId: number | null = null;
  private lastInputRequestId = 0;
  private inputEnded = false;
  private enableConsole: boolean;
  private consoleGeneration = 0;
  private lastOutputSequence = 0;
  private readonly outputDecoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  /** Coalesced append-only console runs; history stores only offsets into this journal. */
  private transcript: MemoryViewerTranscriptEntry[] = [];
  private transcriptRevision = 0;
  private historicalTranscriptCache: {
    readonly checkpoint: ConsoleCheckpoint;
    readonly transcript: readonly MemoryViewerTranscriptEntry[];
  } | null = null;
  private lastEventSequence = 0;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private playbackTimer: ReturnType<typeof setTimeout> | undefined;
  private vmAlive = false;
  private disposed = false;
  private isPlaying = false;
  private history: HistoryEntry[] = [];
  private cursor = 0;
  private historyOffset = 0;
  private lifecycle: MemoryViewerLifecycleBatch | null = null;
  /** Frontier stack; each history entry keeps its persistent node as a historical snapshot. */
  private activeScopeTop: ActiveScopeNode | null = null;
  /** Shared persistent-delta implementation; entries retain the batch for their selected point. */
  private readonly stackSnapshotHistory = new PersistentSnapshotHistory<DebugScalarSnapshot>();
  private readonly staticSnapshotHistory = new PersistentSnapshotHistory<DebugStaticObjectSnapshot>();
  private readonly arraySnapshotHistory = new PersistentSnapshotHistory<DebugArraySnapshot>(128, {
    getId: array => array.rootId,
    sameSnapshot: sameMemoryViewerArraySnapshot,
    cloneSnapshot: cloneMemoryViewerArraySnapshot,
  });
  private readonly aggregateSnapshotHistory = new PersistentSnapshotHistory<DebugAggregateSnapshot>(128, {
    getId: aggregate => aggregate.viewId ?? aggregate.rootId,
    sameSnapshot: sameMemoryViewerAggregateSnapshot,
    cloneSnapshot: cloneMemoryViewerAggregateSnapshot,
  });
  private readonly heapSnapshotHistory = new PersistentSnapshotHistory<DebugHeapObjectSnapshot>();
  private readonly pointerSnapshotHistory = new PersistentSnapshotHistory<DebugPointerSnapshot>(128, {
    sameSnapshot: sameMemoryViewerPointerSnapshot,
    cloneSnapshot: cloneMemoryViewerPointerSnapshot,
  });
  private omittedArrayObjects = 0;
  private omittedAggregateObjects = 0;
  private hasUsedHeap = false;
  private hasHeapAllocationCalls = false;
  private source: string;
  private currentState: MemoryViewerState;

  constructor(source = '', options: MemoryViewerControllerOptions = {}) {
    this.source = source;
    this.configuration = options.configuration ?? RUN_CONFIGURATION;
    this.workerFactory = options.workerFactory ?? createWorker;
    this.maxHistoryEntries = Math.max(1, options.maxHistoryEntries ?? this.configuration.memoryViewer.historySteps);
    this.playbackIntervalMs = Math.max(0, options.playbackIntervalMs ?? this.configuration.memoryViewer.playIntervalMs);
    this.enableConsole = options.enableConsole ?? true;
    this.timers = options.timers ?? defaultTimers();
    this.currentState = this.buildState();
  }

  get state(): MemoryViewerState { return this.currentState; }

  subscribe(listener: (state: MemoryViewerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  private buildState(): MemoryViewerState {
    const entry = this.history[this.cursor];
    const stepIndex = this.history.length === 0 ? 0 : this.historyOffset + this.cursor;
    const selectedIsRunning = this.pendingOriginStep !== null && this.pendingOriginStep === stepIndex;
    const isAtPendingFrontier = selectedIsRunning && this.cursor === this.history.length - 1;
    const isInputWaitVisible = isAtPendingFrontier && this.inputRequestId !== null;
    const status = entry
      ? (isInputWaitVisible ? 'waiting-input' : selectedIsRunning ? 'running' : entry.status)
      : 'starting';
    const hasHistoryFuture = this.cursor < this.history.length - 1;
    const canAdvanceVm = !this.pendingStart && this.pendingRequestId === null && this.vmAlive && entry?.status === 'paused';
    const showTransientMemory = isInputWaitVisible;
    const selectedLifecycle = showTransientMemory ? this.lifecycle : entry?.lifecycle ?? null;
    const selectedScopes = showTransientMemory ? this.activeScopeTop : entry?.activeScopeTop ?? null;
    const heapBatch = showTransientMemory ? this.heapSnapshotHistory.latestBatch : entry?.heapSnapshotHistory ?? null;
    const pointerBatch = showTransientMemory ? this.pointerSnapshotHistory.latestBatch : entry?.pointerSnapshotHistory ?? null;
    const arrayBatch = showTransientMemory ? this.arraySnapshotHistory.latestBatch : entry?.arraySnapshotHistory ?? null;
    const aggregateBatch = showTransientMemory ? this.aggregateSnapshotHistory.latestBatch : entry?.aggregateSnapshotHistory ?? null;
    const stackBatch = showTransientMemory ? this.stackSnapshotHistory.latestBatch : entry?.stackSnapshotHistory ?? null;
    const staticBatch = showTransientMemory ? this.staticSnapshotHistory.latestBatch : entry?.staticSnapshotHistory ?? null;
    const viewingHistory = this.cursor < this.history.length - 1
      || (this.pendingOriginStep !== null && !isAtPendingFrontier);
    const isAtTranscriptFrontier = !entry || this.cursor === this.history.length - 1;
    return {
      source: this.source,
      location: isInputWaitVisible ? this.pendingInputLocation : entry?.location ?? null,
      status,
      isPlaying: this.isPlaying,
      transcript: isAtTranscriptFrontier ? this.transcript : this.materializeTranscript(entry.consoleCheckpoint),
      transcriptRevision: isAtTranscriptFrontier ? this.transcriptRevision : entry.transcriptRevision,
      inputRequestId: isInputWaitVisible ? this.inputRequestId : null,
      isViewingHistory: viewingHistory,
      canStop: this.active !== null && (this.pendingStart || this.pendingRequestId !== null || this.vmAlive),
      canPrevious: this.cursor > 0,
      canNext: hasHistoryFuture || canAdvanceVm,
      stepIndex,
      errorMessage: entry?.errorMessage ?? null,
      historyNotice: this.historyOffset === 0 ? null : this.maxHistoryEntries,
      hasUsedHeap: this.hasUsedHeap,
      hasHeapAllocationCalls: this.hasHeapAllocationCalls,
      lifecycle: selectedLifecycle,
      activeScopes: materializeActiveScopes(selectedScopes),
      heapObjects: this.heapSnapshotHistory.materialize(heapBatch),
      pointers: this.pointerSnapshotHistory.materialize(pointerBatch),
      arrays: this.arraySnapshotHistory.materialize(arrayBatch),
      omittedArrayObjects: showTransientMemory ? this.omittedArrayObjects : entry?.omittedArrayObjects ?? 0,
      aggregates: this.aggregateSnapshotHistory.materialize(aggregateBatch),
      omittedAggregateObjects: showTransientMemory ? this.omittedAggregateObjects : entry?.omittedAggregateObjects ?? 0,
      stackScalars: this.stackSnapshotHistory.materialize(stackBatch),
      staticObjects: this.staticSnapshotHistory.materialize(staticBatch),
    };
  }

  private publish() {
    this.currentState = this.buildState();
    for (const listener of this.listeners) listener(this.currentState);
  }

  start(source = this.source): void {
    this.dispose();
    this.disposed = false;
    this.source = source;
    this.nextRequestId = 0;
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.lastInputRequestId = 0;
    this.inputEnded = false;
    this.lastOutputSequence = 0;
    this.outputDecoders.stdout = new TextDecoder();
    this.outputDecoders.stderr = new TextDecoder();
    this.transcript = [];
    this.transcriptRevision += 1;
    this.historicalTranscriptCache = null;
    this.lastEventSequence = 0;
    this.vmAlive = false;
    this.isPlaying = false;
    this.history = [];
    this.cursor = 0;
    this.historyOffset = 0;
    this.lifecycle = null;
    this.activeScopeTop = null;
    this.heapSnapshotHistory.reset();
    this.pointerSnapshotHistory.reset();
    this.stackSnapshotHistory.reset();
    this.staticSnapshotHistory.reset();
    this.arraySnapshotHistory.reset();
    this.aggregateSnapshotHistory.reset();
    this.omittedArrayObjects = 0;
    this.omittedAggregateObjects = 0;
    this.hasUsedHeap = false;
    this.hasHeapAllocationCalls = false;
    this.publish();

    let worker: Worker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.appendEntry({
        location: null,
        status: 'error',
        errorMessage: this.errorText(error),
        lifecycle: null,
        omittedArrayObjects: 0,
        omittedAggregateObjects: 0,
      });
      this.publish();
      return;
    }

    const jobId = ++this.nextJobId;
    const active = { worker, jobId };
    this.active = active;
    this.pendingStart = true;
    worker.onmessage = (event: MessageEvent<MemoryViewerResponse>) => this.onWorkerMessage(active, event.data);
    worker.onerror = event => {
      event.preventDefault();
      const requestId = this.pendingStart ? null : this.pendingRequestId;
      this.fail(active, requestId, `The Memory Viewer Worker stopped unexpectedly: ${event.message || 'no diagnostic was returned.'}`);
    };
    worker.onmessageerror = () => {
      const requestId = this.pendingStart ? null : this.pendingRequestId;
      this.fail(active, requestId, 'Could not read the Memory Viewer Worker response.');
    };
    this.armWatchdog(active, null);

    try {
      const command: MemoryViewerCommand = {
        type: 'debug-start', jobId, fileName: 'main.c', source,
        configuration: { options: this.configuration.options, debug: this.configuration.debug },
        enableConsole: this.enableConsole,
        consoleGeneration: this.consoleGeneration,
      };
      worker.postMessage(command);
    } catch (error) {
      this.fail(active, null, `Could not send source to the Worker: ${this.errorText(error)}`);
    }
  }

  togglePlay(): void {
    if (this.isPlaying) {
      this.pausePlayback();
      this.publish();
      return;
    }
    if (!this.currentState.canNext) return;
    this.isPlaying = true;
    this.schedulePlaybackTick();
    this.publish();
  }

  setPlaybackIntervalMs(intervalMs: number): boolean {
    if (!isMemoryViewerPlaybackInterval(intervalMs)) return false;
    this.playbackIntervalMs = intervalMs;
    return true;
  }

  previous(): void {
    this.pausePlayback();
    if (this.cursor > 0) {
      this.cursor -= 1;
      this.publish();
    } else if (this.currentState.isPlaying) {
      this.publish();
    }
  }

  next(): void {
    const wasPlaying = this.isPlaying;
    this.pausePlayback();
    this.advance(false);
    if (wasPlaying) this.publish();
  }

  setConsoleEnabled(enabled: boolean): void {
    if (this.enableConsole === enabled) return;
    this.enableConsole = enabled;
    this.consoleGeneration += 1;
    if (!enabled) this.clearConsoleHistory();

    const active = this.active;
    if (active) {
      try {
        active.worker.postMessage({
          type: 'debug-console-enabled', jobId: active.jobId,
          enabled, generation: this.consoleGeneration,
        });
      } catch (error) {
        this.fail(active, this.pendingRequestId, `Could not update console capture: ${this.errorText(error)}`);
        return;
      }
    }
    if (enabled) {
      this.publish();
      return;
    }

    const requestId = this.pendingRequestId;
    const inputRequestId = this.inputRequestId;
    if (active && requestId !== null && inputRequestId !== null) {
      this.sendStdinEOFForRequest(active, requestId, inputRequestId);
      return;
    }
    this.publish();
  }

  sendStdinLine(line: string): boolean {
    const active = this.active;
    const inputRequestId = this.inputRequestId;
    const requestId = this.pendingRequestId;
    if (!this.enableConsole || !active || inputRequestId === null || requestId === null || this.inputEnded
      || this.currentState.inputRequestId !== inputRequestId) return false;

    this.inputRequestId = null;
    try {
      const command: MemoryViewerCommand = {
        type: 'debug-stdin', jobId: active.jobId, requestId, inputRequestId,
        bytes: new TextEncoder().encode(`${line}\n`),
      };
      active.worker.postMessage(command);
    } catch (error) {
      this.fail(active, requestId, `Could not send input: ${this.errorText(error)}`);
      return false;
    }
    this.appendTranscript({ stream: 'stdin', text: `${line}\n` });
    this.armWatchdog(active, requestId);
    this.publish();
    return true;
  }

  sendStdinEOF(): boolean {
    const active = this.active;
    const inputRequestId = this.inputRequestId;
    const requestId = this.pendingRequestId;
    if (!active || inputRequestId === null || requestId === null || this.inputEnded
      || this.currentState.inputRequestId !== inputRequestId) return false;

    return this.sendStdinEOFForRequest(active, requestId, inputRequestId);
  }

  private sendStdinEOFForRequest(active: ActiveWorker, requestId: number, inputRequestId: number): boolean {
    if (this.active !== active || this.pendingRequestId !== requestId || this.inputRequestId !== inputRequestId
      || this.inputEnded) return false;
    this.inputRequestId = null;
    this.inputEnded = true;
    try {
      const command: MemoryViewerCommand = {
        type: 'debug-stdin-eof', jobId: active.jobId, requestId, inputRequestId,
      };
      active.worker.postMessage(command);
    } catch (error) {
      this.fail(active, requestId, `Could not send end of input: ${this.errorText(error)}`);
      return false;
    }
    if (this.enableConsole) this.appendTranscript({ stream: 'system', text: '[EOF]\n', tone: 'system', role: 'input' });
    this.armWatchdog(active, requestId);
    this.publish();
    return true;
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    const pendingOrigin = this.pendingOriginStep;
    const selectedOrigin = pendingOrigin === null
      ? this.cursor === this.history.length - 1
      : this.historyOffset + this.cursor === pendingOrigin;
    const location = this.pendingInputLocation ?? this.pendingOriginLocation ?? this.history[this.cursor]?.location ?? null;

    this.clearWatchdog();
    this.pausePlayback();
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.inputEnded = true;
    this.vmAlive = false;
    this.flushOutputDecoders();
    this.appendTranscript({ stream: 'system', text: 'Debug session stopped.\n', tone: 'warning' });
    this.appendEntry({
      location,
      status: 'cancelled',
      errorMessage: null,
      lifecycle: this.lifecycle,
      omittedArrayObjects: this.omittedArrayObjects,
      omittedAggregateObjects: this.omittedAggregateObjects,
    }, selectedOrigin);
    this.closeWorker(active);
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.pausePlayback();
    this.clearWatchdog();
    this.closeWorker();
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
  }

  private advance(automatic: boolean) {
    if (this.cursor < this.history.length - 1) {
      this.cursor += 1;
      const entry = this.history[this.cursor];
      if (automatic && entry && entry.status !== 'paused') this.pausePlayback();
      this.publish();
      if (automatic && this.isPlaying) this.schedulePlaybackTick();
      return;
    }

    const entry = this.history[this.cursor];
    if (!entry || entry.status !== 'paused' || !this.vmAlive || this.pendingRequestId !== null || !this.active) {
      if (automatic) {
        this.pausePlayback();
        this.publish();
      }
      return;
    }
    this.requestStep(this.active, entry.location, automatic);
  }

  private requestStep(active: ActiveWorker, location: DebugSourceLocation | null, automatic: boolean) {
    if (this.pendingRequestId !== null || !this.vmAlive) return;
    if (!automatic) this.pausePlayback();
    const requestId = ++this.nextRequestId;
    this.pendingRequestId = requestId;
    this.pendingOriginStep = this.historyOffset + this.cursor;
    this.pendingOriginLocation = location;
    this.armWatchdog(active, requestId);
    this.publish();
    try {
      const command: MemoryViewerCommand = { type: 'debug-step', jobId: active.jobId, requestId };
      active.worker.postMessage(command);
    } catch (error) {
      this.fail(active, requestId, `Could not request the next step: ${this.errorText(error)}`);
    }
  }

  private onWorkerMessage(active: ActiveWorker, response: MemoryViewerResponse) {
    if (this.active !== active || response.jobId !== active.jobId) return;
    if (response.type === 'debug-output') {
      if (!this.matchesPending(response.requestId) || response.sequence <= this.lastOutputSequence) return;
      this.lastOutputSequence = response.sequence;
      if (!this.enableConsole || (response.consoleGeneration ?? 0) !== this.consoleGeneration) return;
      const text = this.outputDecoders[response.stream].decode(response.chunk, { stream: true });
      if (text) this.appendTranscript({ stream: response.stream, text });
      return;
    }
    if (response.type === 'debug-ready') {
      if (!this.pendingStart) return;
      this.pendingStart = false;
      this.clearWatchdog();
      this.hasHeapAllocationCalls = response.hasHeapAllocationCalls === true;
      this.acceptEvents(response.events);
      this.acceptHeapObjects(response.heapObjects);
      this.acceptPointers(response.pointers);
      this.acceptArrays(response.arrays, response.omittedArrayObjects);
      this.acceptAggregates(response.aggregates, response.omittedAggregateObjects);
      this.acceptStackScalars(response.stackScalars);
      this.acceptStaticObjects(response.staticObjects);
      this.appendEntry({
        location: response.location,
        status: 'paused',
        errorMessage: null,
        lifecycle: this.lifecycle,
        omittedArrayObjects: this.omittedArrayObjects,
        omittedAggregateObjects: this.omittedAggregateObjects,
      });
      this.vmAlive = true;
      this.publish();
      return;
    }
    if (response.type === 'debug-error') {
      if (!this.matchesPending(response.requestId)) return;
      this.acceptError(active, response.requestId, response.status, response.message);
      return;
    }
    if (!this.matchesPending(response.requestId)) return;
    if (response.progress.kind === 'input-needed') {
      if (response.requestId === null || !Number.isSafeInteger(response.inputRequestId)
        || response.inputRequestId === undefined || response.inputRequestId <= this.lastInputRequestId) return;
      this.clearWatchdog();
      this.pausePlayback();
      this.lastInputRequestId = response.inputRequestId;
      this.inputRequestId = response.inputRequestId;
      this.pendingInputLocation = response.progress.location;
      this.acceptEvents(response.events);
      this.acceptHeapObjects(response.heapObjects);
      this.acceptPointers(response.pointers);
      this.acceptArrays(response.arrays, response.omittedArrayObjects);
      this.acceptAggregates(response.aggregates, response.omittedAggregateObjects);
      this.acceptStackScalars(response.stackScalars);
      this.acceptStaticObjects(response.staticObjects);
      this.vmAlive = true;
      if (!this.enableConsole) {
        this.sendStdinEOFForRequest(active, response.requestId, response.inputRequestId);
        return;
      }
      this.publish();
      return;
    }
    this.clearWatchdog();
    const originStep = this.pendingOriginStep;
    const selectedOrigin = originStep !== null && this.historyOffset + this.cursor === originStep;
    if (response.requestId === null) this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    const location = this.pendingOriginLocation;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.acceptEvents(response.events);
    this.acceptHeapObjects(response.heapObjects);
    this.acceptPointers(response.pointers);
    this.acceptArrays(response.arrays, response.omittedArrayObjects);
    this.acceptAggregates(response.aggregates, response.omittedAggregateObjects);
    this.acceptStackScalars(response.stackScalars);
    this.acceptStaticObjects(response.staticObjects);
    const entry = this.entryForProgress(response.progress, location);
    this.vmAlive = response.progress.kind === 'paused';
    if (!this.vmAlive) this.flushOutputDecoders();
    this.appendEntry(entry, selectedOrigin);
    if (!this.vmAlive) this.closeWorker();
    if (this.isPlaying) {
      if (this.vmAlive) this.schedulePlaybackTick();
      else this.pausePlayback();
    }
    this.publish();
  }

  private matchesPending(requestId: number | null): boolean {
    return requestId === null
      ? this.pendingStart
      : this.pendingRequestId === requestId;
  }

  private entryForProgress(
    progress: MemoryViewerProgress,
    fallbackLocation: DebugSourceLocation | null,
  ): Omit<HistoryEntry, 'activeScopeTop' | 'heapSnapshotHistory' | 'pointerSnapshotHistory' | 'arraySnapshotHistory' | 'aggregateSnapshotHistory' | 'stackSnapshotHistory' | 'staticSnapshotHistory' | 'consoleCheckpoint' | 'transcriptRevision'> {
    return {
      location: progress.kind === 'paused' ? progress.location : fallbackLocation,
      status: statusForProgress(progress),
      errorMessage: progress.kind === 'paused' || progress.kind === 'terminated' ? null : diagnosticMessage(progress),
      lifecycle: this.lifecycle,
      omittedArrayObjects: this.omittedArrayObjects,
      omittedAggregateObjects: this.omittedAggregateObjects,
    };
  }

  /** Store only changed immutable DTOs and checkpoint regularly to bound replay cost. */
  private acceptHeapObjects(snapshot: readonly DebugHeapObjectSnapshot[] | undefined): void {
    this.heapSnapshotHistory.accept(snapshot);
  }

  private acceptStackScalars(snapshot: readonly DebugScalarSnapshot[] | undefined): void {
    this.stackSnapshotHistory.accept(snapshot);
  }

  private acceptStaticObjects(snapshot: readonly DebugStaticObjectSnapshot[] | undefined): void {
    this.staticSnapshotHistory.accept(snapshot);
  }

  private acceptPointers(snapshot: readonly DebugPointerSnapshot[] | undefined): void {
    this.pointerSnapshotHistory.accept(snapshot);
  }

  private acceptArrays(snapshot: readonly DebugArraySnapshot[] | undefined, omittedObjects: number | undefined): void {
    this.arraySnapshotHistory.accept(snapshot);
    this.omittedArrayObjects = Math.max(0, omittedObjects ?? 0);
  }

  private acceptAggregates(snapshot: readonly DebugAggregateSnapshot[] | undefined, omittedObjects: number | undefined): void {
    this.aggregateSnapshotHistory.accept(snapshot);
    this.omittedAggregateObjects = Math.max(0, omittedObjects ?? 0);
  }

  private acceptEvents(events: readonly DebugEvent[]) {
    const freshEvents = events.filter(event => event.sequence > this.lastEventSequence);
    if (freshEvents.length === 0) return;
    this.lastEventSequence = freshEvents[freshEvents.length - 1].sequence;
    if (!this.hasUsedHeap && freshEvents.some(event => event.kind === 'object-create' && event.duration === 'heap')) {
      this.hasUsedHeap = true;
    }
    this.lifecycle = {
      previous: this.lifecycle,
      events: freshEvents,
      eventCount: (this.lifecycle?.eventCount ?? 0) + freshEvents.length,
    };
    // Lifecycle events are authoritative: frame-exit, errors, and limits do not imply scope exits.
    for (const event of freshEvents) {
      if (event.kind === 'scope-enter' && event.scopeId !== null) {
        const scope: MemoryViewerActiveScope = Object.freeze({
          id: event.scopeId,
          frameId: event.frameId,
          functionName: event.functionName,
          scopeName: event.scopeName,
          location: event.location,
        });
        this.activeScopeTop = { scope, previous: this.activeScopeTop };
      } else if (event.kind === 'scope-exit' && event.scopeId !== null) {
        this.activeScopeTop = removeActiveScope(this.activeScopeTop, event.scopeId);
      }
    }
  }

  private acceptError(active: ActiveWorker, requestId: number | null, status: 'error' | 'limit', message: string) {
    this.clearWatchdog();
    const location = requestId === null ? null : this.pendingOriginLocation;
    const originStep = this.pendingOriginStep;
    const selectedOrigin = requestId === null || (originStep !== null && this.historyOffset + this.cursor === originStep);
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.inputEnded = true;
    this.vmAlive = false;
    this.pausePlayback();
    this.flushOutputDecoders();
    this.appendEntry(
      {
        location,
        status,
        errorMessage: message || 'The engine did not return a diagnostic.',
        lifecycle: this.lifecycle,
        omittedArrayObjects: this.omittedArrayObjects,
        omittedAggregateObjects: this.omittedAggregateObjects,
      },
      selectedOrigin,
    );
    this.closeWorker(active);
    this.publish();
  }

  private fail(active: ActiveWorker, requestId: number | null, message: string) {
    if (this.active !== active) return;
    this.acceptError(active, requestId, 'error', message);
  }

  private appendEntry(entry: Omit<HistoryEntry, 'activeScopeTop' | 'heapSnapshotHistory' | 'pointerSnapshotHistory' | 'arraySnapshotHistory' | 'aggregateSnapshotHistory' | 'stackSnapshotHistory' | 'staticSnapshotHistory' | 'consoleCheckpoint' | 'transcriptRevision'>, selectNew?: boolean) {
    const selectedStep = this.historyOffset + this.cursor;
    const wasAtFrontier = this.history.length === 0 || this.cursor === this.history.length - 1;
    this.history.push({
      ...entry,
      activeScopeTop: this.activeScopeTop,
      heapSnapshotHistory: this.heapSnapshotHistory.latestBatch,
      pointerSnapshotHistory: this.pointerSnapshotHistory.latestBatch,
      arraySnapshotHistory: this.arraySnapshotHistory.latestBatch,
      aggregateSnapshotHistory: this.aggregateSnapshotHistory.latestBatch,
      stackSnapshotHistory: this.stackSnapshotHistory.latestBatch,
      staticSnapshotHistory: this.staticSnapshotHistory.latestBatch,
      consoleCheckpoint: this.captureConsoleCheckpoint(),
      transcriptRevision: this.transcriptRevision,
    });
    if (this.history.length > this.maxHistoryEntries) {
      this.history.shift();
      this.historyOffset += 1;
      if (this.cursor > 0) this.cursor -= 1;
      else this.cursor = 0;
    }
    if ((selectNew ?? wasAtFrontier) && (wasAtFrontier || selectedStep === this.historyOffset + this.cursor)) {
      this.cursor = this.history.length - 1;
    }
  }

  private armWatchdog(active: ActiveWorker, requestId: number | null) {
    this.clearWatchdog();
    this.watchdog = this.timers.setTimeout(() => {
      if (this.active !== active || !this.matchesPending(requestId)) return;
      this.acceptError(active, requestId, 'error', `The Memory Viewer exceeded its ${this.configuration.timeoutMs} ms time limit during preparation or stepping.`);
    }, this.configuration.timeoutMs);
  }

  private clearWatchdog() {
    if (this.watchdog === undefined) return;
    this.timers.clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private appendTranscript(entry: MemoryViewerTranscriptEntry): void {
    if (!this.enableConsole || !entry.text) return;
    const previous = this.transcript[this.transcript.length - 1];
    if (previous && previous.stream === entry.stream && previous.tone === entry.tone
      && (entry.stream === 'stdout' || entry.stream === 'stderr')) {
      this.transcript[this.transcript.length - 1] = Object.freeze({ ...previous, text: previous.text + entry.text });
    } else {
      this.transcript.push(Object.freeze({ ...entry }));
    }
    this.transcriptRevision += 1;
  }

  private flushOutputDecoders(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = this.enableConsole ? this.outputDecoders[stream].decode() : '';
      if (tail) this.appendTranscript({ stream, text: tail });
      this.outputDecoders[stream] = new TextDecoder();
    }
  }

  private captureConsoleCheckpoint(): ConsoleCheckpoint {
    if (!this.enableConsole) return EMPTY_CONSOLE_CHECKPOINT;
    return {
      segmentCount: this.transcript.length,
      tailLength: this.transcript.at(-1)?.text.length ?? 0,
    };
  }

  private materializeTranscript(checkpoint: ConsoleCheckpoint): readonly MemoryViewerTranscriptEntry[] {
    if (this.historicalTranscriptCache?.checkpoint === checkpoint) return this.historicalTranscriptCache.transcript;
    const transcript = this.transcript.slice(0, checkpoint.segmentCount);
    const last = transcript.length - 1;
    const entry = transcript[last];
    if (entry && entry.text.length > checkpoint.tailLength) {
      transcript[last] = Object.freeze({ ...entry, text: entry.text.slice(0, checkpoint.tailLength) });
    }
    const snapshot = Object.freeze(transcript);
    this.historicalTranscriptCache = { checkpoint, transcript: snapshot };
    return snapshot;
  }

  private clearConsoleHistory(): void {
    this.transcript = [];
    this.transcriptRevision += 1;
    this.historicalTranscriptCache = null;
    this.outputDecoders.stdout = new TextDecoder();
    this.outputDecoders.stderr = new TextDecoder();
    this.history = this.history.map(entry => ({
      ...entry,
      consoleCheckpoint: EMPTY_CONSOLE_CHECKPOINT,
      transcriptRevision: this.transcriptRevision,
    }));
  }

  private schedulePlaybackTick() {
    if (!this.isPlaying || this.disposed || this.playbackTimer !== undefined) return;
    this.playbackTimer = this.timers.setTimeout(() => {
      this.playbackTimer = undefined;
      if (!this.isPlaying || this.disposed) return;
      this.advance(true);
    }, this.playbackIntervalMs);
  }

  private pausePlayback() {
    this.isPlaying = false;
    if (this.playbackTimer !== undefined) {
      this.timers.clearTimeout(this.playbackTimer);
      this.playbackTimer = undefined;
    }
  }

  private closeWorker(expected?: ActiveWorker) {
    const active = this.active;
    if (!active || (expected && expected !== active)) return;
    this.active = null;
    active.worker.onmessage = null;
    active.worker.onerror = null;
    active.worker.onmessageerror = null;
    active.worker.terminate();
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Materialize a selected persistent lifecycle prefix only when a consumer needs it. */
export function materializeMemoryViewerLifecycle(
  lifecycle: MemoryViewerLifecycleBatch | null,
): readonly DebugEvent[] {
  const batches: (readonly DebugEvent[])[] = [];
  for (let current = lifecycle; current; current = current.previous) batches.push(current.events);
  batches.reverse();
  return batches.flatMap(batch => batch);
}
