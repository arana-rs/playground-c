import type {
  DebugSourceLocation,
} from '@playground/c11-engine/core';
import { RUN_CONFIGURATION } from '../execution/configuration.ts';
import type { RunConfiguration } from '../execution/configuration.ts';
import { getBuildPlanEntryFile, resolveBuildPlan } from '../build/buildPlan.ts';
import {
  cloneWorkspaceSourceSnapshot,
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
} from '../execution/documentSnapshot.ts';
import type {
  ExecutionDocumentSnapshot,
  WorkspaceSourceSnapshot,
} from '../execution/documentSnapshot.ts';
import type { MemoryViewerProgress } from './protocol.ts';
import { MemoryViewerConsole } from './MemoryViewerConsole.ts';
import type { MemoryViewerConsoleCheckpoint } from './MemoryViewerConsole.ts';
import { MemoryViewerSnapshots } from './MemoryViewerSnapshots.ts';
import type { MemoryViewerSnapshotCheckpoint } from './MemoryViewerSnapshots.ts';
import { MemoryViewerWorkerSession } from './MemoryViewerWorkerSession.ts';
import { memoryViewerDiagnosticMessage, memoryViewerStatusForProgress } from './MemoryViewerWorkerSession.ts';
import { isMemoryViewerPlaybackInterval } from './playbackSpeed.ts';
import type {
  MemoryViewerControllerOptions,
  MemoryViewerState,
  MemoryViewerStatus,
} from './memoryViewerControllerTypes.ts';

export {
  MEMORY_VIEWER_HISTORY_LIMIT,
  MEMORY_VIEWER_PLAY_INTERVAL_MS,
} from './memoryViewerControllerTypes.ts';
export type {
  MemoryViewerActiveScope,
  MemoryViewerControllerOptions,
  MemoryViewerLifecycleBatch,
  MemoryViewerState,
  MemoryViewerStatus,
  MemoryViewerTranscriptEntry,
} from './memoryViewerControllerTypes.ts';
export { materializeMemoryViewerLifecycle } from './MemoryViewerSnapshots.ts';

interface HistoryEntry {
  readonly location: DebugSourceLocation | null;
  readonly status: MemoryViewerStatus;
  readonly errorMessage: string | null;
  readonly snapshots: MemoryViewerSnapshotCheckpoint;
  readonly consoleCheckpoint: MemoryViewerConsoleCheckpoint;
  readonly transcriptRevision: number;
}

type HistoryEntryDraft = Pick<HistoryEntry, 'location' | 'status' | 'errorMessage'>;

function defaultTimers() {
  return {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
}

/** Owns a single debug Worker and a bounded cursor over already-produced VM steps. */
export class MemoryViewerController {
  private readonly configuration: RunConfiguration;
  private document: ExecutionDocumentSnapshot;
  private sourceSnapshot: WorkspaceSourceSnapshot;
  private readonly maxHistoryEntries: number;
  private playbackIntervalMs: number;
  private readonly timers: NonNullable<MemoryViewerControllerOptions['timers']>;
  private readonly listeners = new Set<(state: MemoryViewerState) => void>();
  private readonly consoleJournal: MemoryViewerConsole;
  private readonly snapshots = new MemoryViewerSnapshots();
  private readonly session: MemoryViewerWorkerSession;
  private playbackTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private isPlaying = false;
  private history: HistoryEntry[] = [];
  private cursor = 0;
  private historyOffset = 0;
  private hasHeapAllocationCalls = false;
  private source: string;
  private entrySourceFile: { readonly name: string; readonly source: string } | null = null;
  private currentState: MemoryViewerState;

  constructor(source: string | ExecutionDocumentSnapshot | WorkspaceSourceSnapshot = '', options: MemoryViewerControllerOptions = {}) {
    const document = typeof source === 'string'
      ? createExecutionDocumentSnapshot(
        options.documentId ?? 'main',
        options.fileName ?? 'main.c',
        options.sourceRevision ?? 0,
        source,
      )
      : createExecutionDocumentSnapshot(source.documentId, source.fileName, source.sourceRevision, source.source);
    this.sourceSnapshot = typeof source === 'object' && 'files' in source
      ? cloneWorkspaceSourceSnapshot(source)
      : createWorkspaceSourceSnapshot(document);
    this.document = document;
    this.source = this.document.source;
    this.updateEntrySourceFile();
    this.configuration = options.configuration ?? RUN_CONFIGURATION;
    this.maxHistoryEntries = Math.max(1, options.maxHistoryEntries ?? this.configuration.memoryViewer.historySteps);
    this.playbackIntervalMs = Math.max(0, options.playbackIntervalMs ?? this.configuration.memoryViewer.playIntervalMs);
    this.timers = options.timers ?? defaultTimers();
    this.consoleJournal = new MemoryViewerConsole(options.enableConsole ?? true);
    this.session = new MemoryViewerWorkerSession(this.configuration, this.consoleJournal, {
      getSelectedStepIndex: () => this.history.length === 0 ? 0 : this.historyOffset + this.cursor,
      isAtHistoryFrontier: () => this.history.length === 0 || this.cursor === this.history.length - 1,
      getCurrentLocation: () => this.history[this.cursor]?.location ?? null,
      getVisibleInputRequestId: () => this.currentState.inputRequestId,
      isPlaying: () => this.isPlaying,
      pausePlayback: () => this.pausePlayback(),
      schedulePlaybackTick: () => this.schedulePlaybackTick(),
      publish: () => this.publish(),
      onReady: response => {
        this.hasHeapAllocationCalls = response.hasHeapAllocationCalls === true;
        this.snapshots.accept(response);
        this.appendEntry({ location: response.location, status: 'paused', errorMessage: null });
      },
      onInputNeeded: response => this.snapshots.accept(response),
      onProgress: (response, fallbackLocation, selectNew) => {
        this.snapshots.accept(response);
        this.appendEntry(this.entryForProgress(response.progress, fallbackLocation), selectNew);
      },
      onError: (location, status, message, selectNew) => {
        this.appendEntry({ location, status, errorMessage: message }, selectNew);
      },
      onStopped: (location, selectNew) => {
        this.appendEntry({ location, status: 'cancelled', errorMessage: null }, selectNew);
      },
      onStartFailure: message => {
        this.appendEntry({ location: null, status: 'error', errorMessage: message });
        this.publish();
      },
    }, options);
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
    const selectedIsRunning = this.session.originStep !== null && this.session.originStep === stepIndex;
    const isAtPendingFrontier = selectedIsRunning && this.cursor === this.history.length - 1;
    const isInputWaitVisible = isAtPendingFrontier && this.session.inputId !== null;
    const status = entry
      ? (isInputWaitVisible ? 'waiting-input' : selectedIsRunning ? 'running' : entry.status)
      : 'starting';
    const hasHistoryFuture = this.cursor < this.history.length - 1;
    const canAdvanceVm = !this.session.isStartPending && this.session.requestId === null
      && this.session.isVmAlive && entry?.status === 'paused';
    const showTransientMemory = isInputWaitVisible;
    const snapshots = this.snapshots.materialize(showTransientMemory ? this.snapshots.capture() : entry?.snapshots ?? null);
    const viewingHistory = this.cursor < this.history.length - 1
      || (this.session.originStep !== null && !isAtPendingFrontier);
    const isAtTranscriptFrontier = !entry || this.cursor === this.history.length - 1;
    const locationFileName = entry?.location?.file;
    const sourceFile = locationFileName
      ? this.sourceSnapshot.files.find(file => file.name === locationFileName)
      : undefined;
    const fallbackSourceFile = this.entrySourceFile;
    const sourceFileName = sourceFile?.name ?? fallbackSourceFile?.name ?? this.document.fileName;
    return {
      document: this.document,
      source: sourceFile?.source ?? fallbackSourceFile?.source ?? this.source,
      sourceFileName,
      location: isInputWaitVisible ? this.session.inputLocation : entry?.location ?? null,
      status,
      isPlaying: this.isPlaying,
      transcript: isAtTranscriptFrontier
        ? this.consoleJournal.entries
        : this.consoleJournal.materialize(entry.consoleCheckpoint),
      transcriptRevision: isAtTranscriptFrontier ? this.consoleJournal.revision : entry.transcriptRevision,
      inputRequestId: isInputWaitVisible ? this.session.inputId : null,
      isViewingHistory: viewingHistory,
      canStop: this.session.canStop,
      canPrevious: this.cursor > 0,
      canNext: hasHistoryFuture || canAdvanceVm,
      stepIndex,
      errorMessage: entry?.errorMessage ?? null,
      historyNotice: this.historyOffset === 0 ? null : this.maxHistoryEntries,
      hasUsedHeap: this.snapshots.hasUsedHeap,
      hasHeapAllocationCalls: this.hasHeapAllocationCalls,
      ...snapshots,
    };
  }

  private publish(): void {
    this.currentState = this.buildState();
    for (const listener of this.listeners) listener(this.currentState);
  }

  private updateEntrySourceFile(): void {
    const resolution = resolveBuildPlan(this.sourceSnapshot.files, this.document.fileName);
    this.entrySourceFile = getBuildPlanEntryFile(this.sourceSnapshot.files, resolution)
      ?? this.sourceSnapshot.files.find(file => file.name === this.document.fileName)
      ?? null;
  }

  start(source: string | WorkspaceSourceSnapshot = this.sourceSnapshot): void {
    this.pausePlayback();
    this.session.reset();
    this.disposed = false;
    if (typeof source === 'string') {
      if (source !== this.document.source) {
        this.document = createExecutionDocumentSnapshot(
          this.document.documentId,
          this.document.fileName,
          this.document.sourceRevision + 1,
          source,
        );
        this.sourceSnapshot = createWorkspaceSourceSnapshot(this.document, this.sourceSnapshot.files);
      }
    } else {
      this.sourceSnapshot = cloneWorkspaceSourceSnapshot(source);
      this.document = createExecutionDocumentSnapshot(
        this.sourceSnapshot.documentId,
        this.sourceSnapshot.fileName,
        this.sourceSnapshot.sourceRevision,
        this.sourceSnapshot.source,
      );
    }
    this.updateEntrySourceFile();
    this.source = this.document.source;
    this.consoleJournal.reset();
    this.snapshots.reset();
    this.isPlaying = false;
    this.history = [];
    this.cursor = 0;
    this.historyOffset = 0;
    this.hasHeapAllocationCalls = false;
    this.publish();
    this.session.start(this.sourceSnapshot);
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
    if (!this.consoleJournal.setEnabled(enabled)) return;
    if (!enabled) this.clearConsoleHistory();
    if (this.session.setConsoleEnabled(enabled, this.consoleJournal.consoleGeneration)) return;
    this.publish();
  }

  sendStdinLine(line: string): boolean {
    return this.session.sendStdinLine(line);
  }

  sendStdinEOF(): boolean {
    return this.session.sendStdinEOF();
  }

  stop(): void {
    this.session.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.pausePlayback();
    this.session.dispose();
  }

  private advance(automatic: boolean): void {
    if (this.cursor < this.history.length - 1) {
      this.cursor += 1;
      const entry = this.history[this.cursor];
      if (automatic && entry && entry.status !== 'paused') this.pausePlayback();
      this.publish();
      if (automatic && this.isPlaying) this.schedulePlaybackTick();
      return;
    }

    const entry = this.history[this.cursor];
    if (!entry || entry.status !== 'paused' || !this.session.isVmAlive || this.session.requestId !== null
      || !this.session.hasActiveWorker) {
      if (automatic) {
        this.pausePlayback();
        this.publish();
      }
      return;
    }
    this.session.requestStep(entry.location, automatic);
  }

  private entryForProgress(
    progress: MemoryViewerProgress,
    fallbackLocation: DebugSourceLocation | null,
  ): HistoryEntryDraft {
    return {
      location: progress.kind === 'paused' ? progress.location : fallbackLocation,
      status: memoryViewerStatusForProgress(progress),
      errorMessage: progress.kind === 'paused' || progress.kind === 'terminated'
        ? null
        : memoryViewerDiagnosticMessage(progress),
    };
  }

  private appendEntry(entry: HistoryEntryDraft, selectNew?: boolean): void {
    const selectedStep = this.historyOffset + this.cursor;
    const wasAtFrontier = this.history.length === 0 || this.cursor === this.history.length - 1;
    this.history.push({
      ...entry,
      snapshots: this.snapshots.capture(),
      consoleCheckpoint: this.consoleJournal.captureCheckpoint(),
      transcriptRevision: this.consoleJournal.revision,
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

  private clearConsoleHistory(): void {
    const checkpoint = this.consoleJournal.captureCheckpoint();
    this.history = this.history.map(entry => ({
      ...entry,
      consoleCheckpoint: checkpoint,
      transcriptRevision: this.consoleJournal.revision,
    }));
  }

  private schedulePlaybackTick(): void {
    if (!this.isPlaying || this.disposed || this.playbackTimer !== undefined) return;
    this.playbackTimer = this.timers.setTimeout(() => {
      this.playbackTimer = undefined;
      if (!this.isPlaying || this.disposed) return;
      this.advance(true);
    }, this.playbackIntervalMs);
  }

  private pausePlayback(): void {
    this.isPlaying = false;
    if (this.playbackTimer !== undefined) {
      this.timers.clearTimeout(this.playbackTimer);
      this.playbackTimer = undefined;
    }
  }
}
