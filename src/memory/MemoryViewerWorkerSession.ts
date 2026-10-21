import type { DebugSourceLocation } from '@playground/c11-engine/core';
import type { RunConfiguration } from '../execution/configuration.ts';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';
import { MemoryViewerConsole } from './MemoryViewerConsole.ts';
import type { MemoryViewerControllerOptions } from './memoryViewerControllerTypes.ts';
import type { MemoryViewerCommand, MemoryViewerProgress, MemoryViewerResponse } from './protocol.ts';

type ReadyResponse = Extract<MemoryViewerResponse, { type: 'debug-ready' }>;
type ProgressResponse = Extract<MemoryViewerResponse, { type: 'debug-progress' }>;

interface ActiveWorker {
  readonly worker: Worker;
  readonly jobId: number;
}

export interface MemoryViewerWorkerSessionCallbacks {
  getSelectedStepIndex(): number;
  isAtHistoryFrontier(): boolean;
  getCurrentLocation(): DebugSourceLocation | null;
  getVisibleInputRequestId(): number | null;
  isPlaying(): boolean;
  pausePlayback(): void;
  schedulePlaybackTick(): void;
  publish(): void;
  onReady(response: ReadyResponse): void;
  onInputNeeded(response: ProgressResponse): void;
  onProgress(response: ProgressResponse, fallbackLocation: DebugSourceLocation | null, selectNew: boolean): void;
  onError(location: DebugSourceLocation | null, status: 'error' | 'limit', message: string, selectNew: boolean): void;
  onStopped(location: DebugSourceLocation | null, selectNew: boolean): void;
  onStartFailure(message: string): void;
}

/** Owns Worker requests, input waits, and the debug-session watchdog. */
export class MemoryViewerWorkerSession {
  private readonly configuration: RunConfiguration;
  private readonly consoleJournal: MemoryViewerConsole;
  private readonly callbacks: MemoryViewerWorkerSessionCallbacks;
  private readonly workerFactory: () => Worker;
  private readonly timers: NonNullable<MemoryViewerControllerOptions['timers']>;
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
  private lastOutputSequence = 0;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private vmAlive = false;

  constructor(
    configuration: RunConfiguration,
    consoleJournal: MemoryViewerConsole,
    callbacks: MemoryViewerWorkerSessionCallbacks,
    options: Pick<MemoryViewerControllerOptions, 'workerFactory' | 'timers'>,
  ) {
    this.configuration = configuration;
    this.consoleJournal = consoleJournal;
    this.callbacks = callbacks;
    this.workerFactory = options.workerFactory ?? createWorker;
    this.timers = options.timers ?? defaultTimers();
  }

  get isStartPending(): boolean { return this.pendingStart; }
  get requestId(): number | null { return this.pendingRequestId; }
  get originStep(): number | null { return this.pendingOriginStep; }
  get inputLocation(): DebugSourceLocation | null { return this.pendingInputLocation; }
  get inputId(): number | null { return this.inputRequestId; }
  get isVmAlive(): boolean { return this.vmAlive; }
  get hasActiveWorker(): boolean { return this.active !== null; }
  get canStop(): boolean {
    return this.active !== null && (this.pendingStart || this.pendingRequestId !== null || this.vmAlive);
  }

  reset(): void {
    this.dispose();
    this.nextRequestId = 0;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.lastInputRequestId = 0;
    this.inputEnded = false;
    this.lastOutputSequence = 0;
    this.vmAlive = false;
  }

  start(snapshot: WorkspaceSourceSnapshot): void {
    let worker: Worker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.callbacks.onStartFailure(this.errorText(error));
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
        type: 'debug-start', jobId, snapshot,
        configuration: { options: this.configuration.options, debug: this.configuration.debug },
        enableConsole: this.consoleJournal.isEnabled,
        consoleGeneration: this.consoleJournal.consoleGeneration,
      };
      worker.postMessage(command);
    } catch (error) {
      this.fail(active, null, `Could not send source to the Worker: ${this.errorText(error)}`);
    }
  }

  requestStep(location: DebugSourceLocation | null, automatic: boolean): void {
    const active = this.active;
    if (!active || this.pendingRequestId !== null || !this.vmAlive) return;
    if (!automatic) this.callbacks.pausePlayback();
    const requestId = ++this.nextRequestId;
    this.pendingRequestId = requestId;
    this.pendingOriginStep = this.callbacks.getSelectedStepIndex();
    this.pendingOriginLocation = location;
    this.armWatchdog(active, requestId);
    this.callbacks.publish();
    try {
      const command: MemoryViewerCommand = { type: 'debug-step', jobId: active.jobId, requestId };
      active.worker.postMessage(command);
    } catch (error) {
      this.fail(active, requestId, `Could not request the next step: ${this.errorText(error)}`);
    }
  }

  setConsoleEnabled(enabled: boolean, generation: number): boolean {
    const active = this.active;
    if (!active) return false;
    try {
      active.worker.postMessage({
        type: 'debug-console-enabled', jobId: active.jobId, enabled, generation,
      });
    } catch (error) {
      this.fail(active, this.pendingRequestId, `Could not update console capture: ${this.errorText(error)}`);
      return true;
    }
    const requestId = this.pendingRequestId;
    const inputRequestId = this.inputRequestId;
    if (!enabled && requestId !== null && inputRequestId !== null) {
      this.sendStdinEOFForRequest(active, requestId, inputRequestId);
      return true;
    }
    return false;
  }

  sendStdinLine(line: string): boolean {
    const active = this.active;
    const inputRequestId = this.inputRequestId;
    const requestId = this.pendingRequestId;
    if (!this.consoleJournal.isEnabled || !active || inputRequestId === null || requestId === null || this.inputEnded
      || this.callbacks.getVisibleInputRequestId() !== inputRequestId) return false;

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
    this.consoleJournal.append({ stream: 'stdin', text: `${line}\n` });
    this.armWatchdog(active, requestId);
    this.callbacks.publish();
    return true;
  }

  sendStdinEOF(): boolean {
    const active = this.active;
    const inputRequestId = this.inputRequestId;
    const requestId = this.pendingRequestId;
    if (!active || inputRequestId === null || requestId === null || this.inputEnded
      || this.callbacks.getVisibleInputRequestId() !== inputRequestId) return false;
    return this.sendStdinEOFForRequest(active, requestId, inputRequestId);
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    const pendingOrigin = this.pendingOriginStep;
    const selectedOrigin = pendingOrigin === null
      ? this.callbacks.isAtHistoryFrontier()
      : this.callbacks.getSelectedStepIndex() === pendingOrigin;
    const location = this.pendingInputLocation ?? this.pendingOriginLocation ?? this.callbacks.getCurrentLocation();

    this.clearWatchdog();
    this.callbacks.pausePlayback();
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.inputEnded = true;
    this.vmAlive = false;
    this.consoleJournal.flushOutputDecoders();
    this.consoleJournal.append({ stream: 'system', text: 'Debug session stopped.\n', tone: 'warning' });
    this.callbacks.onStopped(location, selectedOrigin);
    this.closeWorker(active);
    this.callbacks.publish();
  }

  dispose(): void {
    this.clearWatchdog();
    this.closeWorker();
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
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
    if (this.consoleJournal.isEnabled) {
      this.consoleJournal.append({ stream: 'system', text: '[EOF]\n', tone: 'system', role: 'input' });
    }
    this.armWatchdog(active, requestId);
    this.callbacks.publish();
    return true;
  }

  private onWorkerMessage(active: ActiveWorker, response: MemoryViewerResponse): void {
    if (this.active !== active || response.jobId !== active.jobId) return;
    if (response.type === 'debug-output') {
      if (!this.matchesPending(response.requestId) || response.sequence <= this.lastOutputSequence) return;
      this.lastOutputSequence = response.sequence;
      if (!this.consoleJournal.isEnabled || (response.consoleGeneration ?? 0) !== this.consoleJournal.consoleGeneration) return;
      this.consoleJournal.acceptOutput(response.stream, response.chunk);
      return;
    }
    if (response.type === 'debug-ready') {
      if (!this.pendingStart) return;
      this.pendingStart = false;
      this.clearWatchdog();
      this.callbacks.onReady(response);
      this.vmAlive = true;
      this.callbacks.publish();
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
      this.callbacks.pausePlayback();
      this.lastInputRequestId = response.inputRequestId;
      this.inputRequestId = response.inputRequestId;
      this.pendingInputLocation = response.progress.location;
      this.callbacks.onInputNeeded(response);
      this.vmAlive = true;
      if (!this.consoleJournal.isEnabled) {
        this.sendStdinEOFForRequest(active, response.requestId, response.inputRequestId);
        return;
      }
      this.callbacks.publish();
      return;
    }
    this.clearWatchdog();
    const originStep = this.pendingOriginStep;
    const selectedOrigin = originStep !== null && this.callbacks.getSelectedStepIndex() === originStep;
    if (response.requestId === null) this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    const location = this.pendingOriginLocation;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.vmAlive = response.progress.kind === 'paused';
    if (!this.vmAlive) this.consoleJournal.flushOutputDecoders();
    this.callbacks.onProgress(response, location, selectedOrigin);
    if (!this.vmAlive) this.closeWorker();
    if (this.callbacks.isPlaying()) {
      if (this.vmAlive) this.callbacks.schedulePlaybackTick();
      else this.callbacks.pausePlayback();
    }
    this.callbacks.publish();
  }

  private matchesPending(requestId: number | null): boolean {
    return requestId === null ? this.pendingStart : this.pendingRequestId === requestId;
  }

  private acceptError(active: ActiveWorker, requestId: number | null, status: 'error' | 'limit', message: string): void {
    this.clearWatchdog();
    const location = requestId === null ? null : this.pendingOriginLocation;
    const originStep = this.pendingOriginStep;
    const selectedOrigin = requestId === null || (originStep !== null
      && this.callbacks.getSelectedStepIndex() === originStep);
    this.pendingStart = false;
    this.pendingRequestId = null;
    this.pendingOriginStep = null;
    this.pendingOriginLocation = null;
    this.pendingInputLocation = null;
    this.inputRequestId = null;
    this.inputEnded = true;
    this.vmAlive = false;
    this.callbacks.pausePlayback();
    this.consoleJournal.flushOutputDecoders();
    this.callbacks.onError(location, status, message || 'The engine did not return a diagnostic.', selectedOrigin);
    this.closeWorker(active);
    this.callbacks.publish();
  }

  private fail(active: ActiveWorker, requestId: number | null, message: string): void {
    if (this.active !== active) return;
    this.acceptError(active, requestId, 'error', message);
  }

  private armWatchdog(active: ActiveWorker, requestId: number | null): void {
    this.clearWatchdog();
    this.watchdog = this.timers.setTimeout(() => {
      if (this.active !== active || !this.matchesPending(requestId)) return;
      this.acceptError(active, requestId, 'error', `The Memory Viewer exceeded its ${this.configuration.timeoutMs} ms time limit during preparation or stepping.`);
    }, this.configuration.timeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog === undefined) return;
    this.timers.clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private closeWorker(expected?: ActiveWorker): void {
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

function createWorker(): Worker {
  return new Worker(new URL('./memory.worker.ts', import.meta.url), { type: 'module' });
}

function defaultTimers() {
  return {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
}

function diagnosticMessage(progress: Exclude<MemoryViewerProgress, { kind: 'paused' }>): string | null {
  if (!('diagnostics' in progress) || progress.diagnostics.length === 0) return null;
  return progress.diagnostics
    .map(item => `${item.file}:${item.line}:${item.column}: ${item.message}`)
    .join('\n');
}

export function memoryViewerStatusForProgress(progress: MemoryViewerProgress):
  'paused' | 'waiting-input' | 'terminated' | 'limit' | 'error' {
  if (progress.kind === 'paused') return 'paused';
  if (progress.kind === 'input-needed') return 'waiting-input';
  if (progress.kind === 'terminated') return 'terminated';
  if (progress.kind === 'limit' || progress.kind === 'debug-limit') return 'limit';
  return 'error';
}

export function memoryViewerDiagnosticMessage(progress: Exclude<MemoryViewerProgress, { kind: 'paused' }>): string | null {
  return diagnosticMessage(progress);
}
