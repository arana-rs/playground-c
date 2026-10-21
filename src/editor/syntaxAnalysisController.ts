import type { Diagnostic, PrepareOptions, PrepareResource } from '@playground/c11-engine/core';
import type { SyntaxAnalysisRequest, SyntaxAnalysisResponse } from './syntaxAnalysisProtocol.ts';
import { cloneWorkspaceSourceSnapshot, sameWorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';

export type SyntaxAnalysisState =
  | { status: 'off' }
  | { status: 'analyzing' }
  | { status: 'ok' }
  | {
    status: 'analysis-errors';
    snapshot: WorkspaceSourceSnapshot;
    diagnostics: readonly Diagnostic[];
    diagnosticCount: number;
    truncated: boolean;
  }
  | { status: 'limit'; resource: PrepareResource }
  | { status: 'unavailable' }
  | { status: 'timeout' };

export interface SyntaxAnalysisWorker {
  onmessage: ((event: MessageEvent<SyntaxAnalysisResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: SyntaxAnalysisRequest): void;
  terminate(): void;
}

export interface SyntaxAnalysisTimers {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface SyntaxAnalysisControllerOptions {
  workerFactory: () => SyntaxAnalysisWorker;
  onStateChange: (state: SyntaxAnalysisState) => void;
  timers?: SyntaxAnalysisTimers;
  debounceMs?: number;
  timeoutMs: number;
}

export const SYNTAX_ANALYSIS_DEBOUNCE_MS = 300;

const browserTimers: SyntaxAnalysisTimers = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: handle => window.clearTimeout(handle),
};

const OFF_STATE: SyntaxAnalysisState = { status: 'off' };
const ANALYZING_STATE: SyntaxAnalysisState = { status: 'analyzing' };

export class SyntaxAnalysisController {
  private readonly workerFactory: () => SyntaxAnalysisWorker;
  private readonly onStateChange: (state: SyntaxAnalysisState) => void;
  private readonly timers: SyntaxAnalysisTimers;
  private readonly debounceMs: number;
  private enabled = false;
  private composing = false;
  private snapshot: WorkspaceSourceSnapshot | null = null;
  private options: PrepareOptions = {};
  private timeoutMs: number;
  private state: SyntaxAnalysisState = OFF_STATE;
  private worker: SyntaxAnalysisWorker | null = null;
  private debounceTimer: number | null = null;
  private timeoutTimer: number | null = null;
  private activeJobId: number | null = null;
  private activeSnapshot: WorkspaceSourceSnapshot | null = null;
  private nextJobId = 0;

  constructor(options: SyntaxAnalysisControllerOptions) {
    this.workerFactory = options.workerFactory;
    this.onStateChange = options.onStateChange;
    this.timers = options.timers ?? browserTimers;
    this.debounceMs = options.debounceMs ?? SYNTAX_ANALYSIS_DEBOUNCE_MS;
    this.timeoutMs = options.timeoutMs;
  }

  get currentState(): SyntaxAnalysisState {
    return this.state;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.cancelPendingWork();
    if (!enabled) {
      this.terminateWorker();
      this.publish(OFF_STATE);
      return;
    }
    this.publish(ANALYZING_STATE);
    this.queueLatestSource();
  }

  setSnapshot(snapshot: WorkspaceSourceSnapshot): void {
    if (this.snapshot && sameWorkspaceSourceSnapshot(this.snapshot, snapshot)) return;
    this.snapshot = cloneWorkspaceSourceSnapshot(snapshot);
    if (!this.enabled) return;
    this.cancelPendingWork();
    this.publish(ANALYZING_STATE);
    this.queueLatestSource();
  }

  setOptions(options: PrepareOptions): void {
    if (this.options === options) return;
    this.options = options;
    if (!this.enabled) return;
    this.cancelPendingWork();
    this.publish(ANALYZING_STATE);
    this.queueLatestSource();
  }

  setTimeoutMs(timeoutMs: number): void {
    if (this.timeoutMs === timeoutMs) return;
    this.timeoutMs = timeoutMs;
    if (!this.enabled) return;
    this.cancelPendingWork();
    this.publish(ANALYZING_STATE);
    this.queueLatestSource();
  }

  setComposing(composing: boolean): void {
    if (this.composing === composing) return;
    this.composing = composing;
    if (!this.enabled) return;
    this.cancelPendingWork();
    this.publish(ANALYZING_STATE);
    if (!composing) this.queueLatestSource();
  }

  dispose(): void {
    this.enabled = false;
    this.cancelPendingWork();
    this.terminateWorker();
    this.state = OFF_STATE;
  }

  private publish(state: SyntaxAnalysisState): void {
    this.state = state;
    this.onStateChange(state);
  }

  private queueLatestSource(): void {
    if (!this.enabled || this.composing) return;
    this.clearDebounceTimer();
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = null;
      this.startLatestSource();
    }, this.debounceMs);
  }

  private startLatestSource(): void {
    if (!this.enabled || this.composing) return;
    const snapshot = this.snapshot;
    if (!snapshot) return;
    let worker = this.worker;
    try {
      if (!worker) {
        worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = event => this.receiveResponse(event.data);
        worker.onerror = () => this.failActiveJob('unavailable');
        worker.onmessageerror = () => this.failActiveJob('unavailable');
      }
    } catch {
      this.publish({ status: 'unavailable' });
      return;
    }

    const jobId = ++this.nextJobId;
    this.activeJobId = jobId;
    this.activeSnapshot = snapshot;
    this.timeoutTimer = this.timers.setTimeout(() => {
      this.timeoutTimer = null;
      if (this.activeJobId !== jobId) return;
      this.activeJobId = null;
      this.activeSnapshot = null;
      this.terminateWorker();
      this.publish({ status: 'timeout' });
    }, this.timeoutMs);

    const request: SyntaxAnalysisRequest = {
      type: 'analyze',
      jobId,
      snapshot,
      options: this.options,
    };
    try {
      worker.postMessage(request);
    } catch {
      this.failActiveJob('unavailable');
    }
  }

  private receiveResponse(response: SyntaxAnalysisResponse): void {
    if (!response || response.jobId !== this.activeJobId) return;
    this.activeJobId = null;
    const snapshot = this.activeSnapshot;
    this.activeSnapshot = null;
    this.clearTimeoutTimer();
    if (!snapshot) {
      this.publish({ status: 'unavailable' });
      return;
    }
    if (response.type === 'error') {
      this.publish({ status: 'unavailable' });
      return;
    }

    const result = response.result;
    if (result.kind === 'ok') this.publish({ status: 'ok' });
    else if (result.kind === 'error') {
      if (result.diagnostics.length === 0 || result.diagnostics.some(diagnostic => [
        'ENGINE_INTERNAL_ERROR', 'INVALID_OPTIONS', 'INVALID_PROJECT',
      ].includes(diagnostic.code))) {
        this.publish({ status: 'unavailable' });
        return;
      }
      this.publish({
        status: 'analysis-errors',
        snapshot,
        diagnostics: result.diagnostics,
        diagnosticCount: result.diagnostics.length,
        truncated: result.truncated,
      });
    } else if (result.kind === 'limit') {
      this.publish({ status: 'limit', resource: result.resource });
    } else {
      this.publish({ status: 'unavailable' });
    }
  }

  private failActiveJob(status: 'unavailable'): void {
    if (this.activeJobId === null) return;
    this.activeJobId = null;
    this.activeSnapshot = null;
    this.clearTimeoutTimer();
    this.terminateWorker();
    this.publish({ status });
  }

  private cancelPendingWork(): void {
    this.clearDebounceTimer();
    this.clearTimeoutTimer();
    if (this.activeJobId !== null) {
      this.activeJobId = null;
      this.activeSnapshot = null;
      this.terminateWorker();
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer === null) return;
    this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer === null) return;
    this.timers.clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }

  private terminateWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
}
