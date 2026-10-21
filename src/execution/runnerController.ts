import {
  emptyRunDiagnosticMetrics,
  emptyRunDiagnosticStages,
  RUN_DIAGNOSTIC_STAGE,
} from './diagnostics.ts';
import type {
  RunDiagnosticBudgets,
  RunDiagnosticMetrics,
  RunDiagnosticStage,
  RunDiagnosticStages,
  RunDiagnosticsReport,
  RunWorkerProgress,
} from './diagnostics.ts';
import type { RunRequest, RunResponse, WorkerCommand } from './protocol.ts';
import {
  cloneWorkspaceSourceSnapshot,
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
} from './documentSnapshot.ts';
import type { ExecutionDocumentSnapshot, WorkspaceSourceSnapshot } from './documentSnapshot.ts';
import { RUN_CONFIGURATION } from './configuration.ts';
import type { RunConfiguration } from './configuration.ts';
import {
  addSystemEntry,
  appendEntry,
  errorText,
  formatDuration,
  formatResultSummary,
} from './consoleOutput.ts';
import type { ConsoleEntry, RunnerState } from './consoleOutput.ts';

interface ActiveRun {
  jobId: number;
  worker: Worker;
  configuration: RunConfiguration;
  startedAt: number;
  document: ExecutionDocumentSnapshot;
  sourceSnapshot: WorkspaceSourceSnapshot;
  fileSizeBytes: number;
  timeout: ReturnType<typeof setTimeout> | undefined;
  timeoutStartedAt: number | null;
  timeoutRemainingMs: number;
  watchdogActiveElapsedMs: number;
  inputRequestId: number | null;
  lastRequestId: number;
  lastOutputSequence: number;
  inputEnded: boolean;
  decoders: Record<'stdout' | 'stderr', TextDecoder>;
  stages: RunDiagnosticStages;
  metrics: RunDiagnosticMetrics;
  lastStage: RunDiagnosticStage;
  lastStageObservedAt: number | null;
  sourceLineCount: number | null;
  dispatchStartedAt: number | null;
  firstWorkerEventAt: number | null;
}

function createWorker(): Worker {
  return new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
}

function closeRun(run: ActiveRun) {
  if (run.timeout !== undefined) clearTimeout(run.timeout);
  run.worker.onmessage = null;
  run.worker.onerror = null;
  run.worker.onmessageerror = null;
  run.worker.terminate();
}

function diagnosticBudgets(configuration: RunConfiguration): RunDiagnosticBudgets {
  const prepare = configuration.options.prepare?.limits;
  const execute = configuration.options.execute?.limits;
  return {
    uiWatchdogMs: configuration.timeoutMs,
    prepare: {
      maxSourceChars: prepare?.maxSourceChars ?? null,
      maxTokens: prepare?.maxTokens ?? null,
      maxPreprocessSteps: prepare?.maxPreprocessSteps ?? null,
      maxDepth: prepare?.maxDepth ?? null,
    },
    execute: {
      maxInstructions: execute?.maxInstructions ?? null,
      maxMemoryBytes: execute?.maxMemoryBytes ?? null,
      maxIOBytes: execute?.maxIOBytes ?? null,
      maxDepth: execute?.maxDepth ?? null,
    },
  };
}

export class RunnerController {
  private active: ActiveRun | null = null;
  private nextJobId = 0;
  private currentState: RunnerState = { status: 'idle', transcript: [] };
  private readonly listeners = new Set<(state: RunnerState) => void>();
  private readonly configuration: RunConfiguration;
  private readonly workerFactory: () => Worker;

  constructor(
    configuration: RunConfiguration = RUN_CONFIGURATION,
    workerFactory: () => Worker = createWorker,
  ) {
    this.configuration = configuration;
    this.workerFactory = workerFactory;
  }

  get state(): RunnerState { return this.currentState; }

  subscribe(listener: (state: RunnerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  private publish(state: RunnerState) {
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
  }

  private append(current: ActiveRun, entry: ConsoleEntry) {
    if (this.active !== current) return;
    const state = this.currentState;
    if (state.status !== 'running') return;
    this.publish({ ...state, transcript: appendEntry(state.transcript, entry) });
  }

  private flushDecoders(current: ActiveRun): readonly ConsoleEntry[] {
    let transcript = this.currentState.transcript;
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = current.decoders[stream].decode();
      if (text) transcript = appendEntry(transcript, { stream, text });
    }
    return transcript;
  }

  private finish(current: ActiveRun, state: RunnerState) {
    if (this.active !== current) return;
    this.active = null;
    closeRun(current);
    this.publish(state);
  }

  private timeout(current: ActiveRun) {
    const diagnosticsReport = this.timeoutReport(current);
    const transcript = addSystemEntry(
      this.flushDecoders(current),
      `The ${formatDuration(current.configuration.timeoutMs)} time limit expired while starting, reading, preparing, or running "${current.document.fileName}"; execution stopped. Check for slow code such as loops or recursion. A valid program may also need more time.`,
      'warning',
    );
    this.finish(current, {
      status: 'timeout',
      document: current.document,
      timeoutMs: current.configuration.timeoutMs,
      diagnosticsReport,
      transcript,
    });
  }

  private armWatchdog(current: ActiveRun) {
    if (current.timeout !== undefined) clearTimeout(current.timeout);
    current.timeoutStartedAt = performance.now();
    current.timeout = setTimeout(() => {
      if (this.active !== current || current.inputRequestId !== null) return;
      const elapsed = performance.now() - (current.timeoutStartedAt ?? performance.now());
      current.watchdogActiveElapsedMs += elapsed;
      current.timeoutRemainingMs = Math.max(0, current.timeoutRemainingMs - elapsed);
      current.timeout = undefined;
      current.timeoutStartedAt = null;
      if (current.timeoutRemainingMs <= 0) this.timeout(current);
      else this.armWatchdog(current);
    }, Math.max(0, current.timeoutRemainingMs));
  }

  private pauseWatchdog(current: ActiveRun): boolean {
    if (current.timeout !== undefined) clearTimeout(current.timeout);
    current.timeout = undefined;
    if (current.timeoutStartedAt !== null) {
      const elapsed = performance.now() - current.timeoutStartedAt;
      current.watchdogActiveElapsedMs += elapsed;
      current.timeoutRemainingMs = Math.max(0, current.timeoutRemainingMs - elapsed);
      current.timeoutStartedAt = null;
    }
    if (current.timeoutRemainingMs <= 0) {
      this.timeout(current);
      return false;
    }
    return true;
  }

  private timeoutReport(current: ActiveRun): RunDiagnosticsReport {
    const now = performance.now();
    const lastStageObservedMs = current.lastStageObservedAt === null
      ? null
      : Math.max(0, now - current.lastStageObservedAt);
    return {
      schemaVersion: 1,
      outcome: 'timeout',
      reason: 'ui-watchdog',
      document: {
        id: current.document.documentId,
        sourceRevision: current.document.sourceRevision,
      },
      file: {
        name: current.document.fileName,
        sizeBytes: current.fileSizeBytes,
        lineCount: current.sourceLineCount,
      },
      budgets: diagnosticBudgets(current.configuration),
      stages: {
        ...current.stages,
        watchdogActiveMs: this.watchdogActiveMs(current, now),
        mainTotalObservedMs: Math.max(0, now - current.startedAt),
        lastStageObservedMs,
      },
      lastStage: current.lastStage,
      metrics: { ...current.metrics },
      diagnostic: {
        code: 'RUN_TIMEOUT_UI',
        message: `The interface watchdog stopped the Worker after ${formatDuration(current.configuration.timeoutMs)} of active time; stdin waits are excluded from the budget.`,
      },
    };
  }

  private watchdogActiveMs(current: ActiveRun, now = performance.now()): number {
    const activeSegmentMs = current.timeoutStartedAt === null ? 0 : Math.max(0, now - current.timeoutStartedAt);
    return current.watchdogActiveElapsedMs + activeSegmentMs;
  }

  private observeWorkerEvent(current: ActiveRun, now = performance.now()) {
    if (current.firstWorkerEventAt !== null) return;
    current.firstWorkerEventAt = now;
    if (current.dispatchStartedAt !== null) {
      current.stages.dispatchToFirstWorkerEventMs = Math.max(0, now - current.dispatchStartedAt);
    }
  }

  private setObservedStage(current: ActiveRun, stage: RunDiagnosticStage, at = performance.now()) {
    current.lastStage = stage;
    current.lastStageObservedAt = at;
  }

  private updateWorkerProgress(current: ActiveRun, progress: RunWorkerProgress) {
    this.setObservedStage(current, progress.stage);
    if (progress.sourceLineCount !== undefined) current.sourceLineCount = progress.sourceLineCount;
    if (progress.stages) Object.assign(current.stages, progress.stages);
    if (progress.metrics) {
      for (const [key, value] of Object.entries(progress.metrics) as Array<[keyof RunDiagnosticMetrics, number | null | undefined]>) {
        // null means this phase has not produced a snapshot. Keep any earlier
        // observation; each counter is a snapshot, never a delta to add.
        if (value !== null && value !== undefined) current.metrics[key] = value;
      }
    }
  }

  private fail(current: ActiveRun, reason: 'start' | 'run' | 'response' | 'send', message: string) {
    const transcript = addSystemEntry(this.flushDecoders(current), errorText(current.document.fileName, reason, message), 'error');
    this.finish(current, { status: 'error', document: current.document, reason, message, transcript });
  }

  run(document: ExecutionDocumentSnapshot | WorkspaceSourceSnapshot, configuration: RunConfiguration = this.configuration): void {
    if (this.active) return;
    const snapshot = createExecutionDocumentSnapshot(
      document.documentId,
      document.fileName,
      document.sourceRevision,
      document.source,
    );
    const sourceSnapshot = 'files' in document
      ? cloneWorkspaceSourceSnapshot(document)
      : createWorkspaceSourceSnapshot(snapshot);
    const fileSizeBytes = new TextEncoder().encode(snapshot.source).byteLength;
    const startedAt = performance.now();
    const jobId = ++this.nextJobId;
    let worker: Worker;
    const workerCreateStartedAt = performance.now();
    let workerCreateMs: number;
    try {
      worker = this.workerFactory();
      workerCreateMs = performance.now() - workerCreateStartedAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The browser could not start the execution engine.';
      this.publish({
        status: 'error', document: snapshot, reason: 'start', message,
        transcript: [{ stream: 'system', text: errorText(snapshot.fileName, 'start', message), tone: 'error' }],
      });
      return;
    }

    const current: ActiveRun = {
      jobId,
      worker,
      configuration,
      startedAt,
      document: snapshot,
      sourceSnapshot,
      fileSizeBytes,
      timeout: undefined,
      timeoutStartedAt: null,
      timeoutRemainingMs: configuration.timeoutMs,
      watchdogActiveElapsedMs: 0,
      inputRequestId: null,
      lastRequestId: 0,
      lastOutputSequence: 0,
      inputEnded: false,
      decoders: { stdout: new TextDecoder(), stderr: new TextDecoder() },
      stages: { ...emptyRunDiagnosticStages(), workerCreateMs },
      metrics: emptyRunDiagnosticMetrics(),
      lastStage: RUN_DIAGNOSTIC_STAGE.workerStartup,
      lastStageObservedAt: null,
      sourceLineCount: null,
      dispatchStartedAt: null,
      firstWorkerEventAt: null,
    };
    this.active = current;
    this.publish({ status: 'running', document: snapshot, transcript: [], inputRequestId: null });

    worker.onmessage = (event: MessageEvent<RunResponse>) => this.onWorkerMessage(current, event.data);
    worker.onerror = event => {
      this.observeWorkerEvent(current);
      event.preventDefault();
      this.fail(current, 'run', event.message || 'The execution engine stopped unexpectedly without returning a diagnostic.');
    };
    worker.onmessageerror = () => {
      this.observeWorkerEvent(current);
      this.fail(current, 'response', 'The browser could not read the execution engine response.');
    };

    this.armWatchdog(current);
    const request: RunRequest = { type: 'run', jobId, snapshot: sourceSnapshot, options: configuration.options };
    const dispatchStartedAt = performance.now();
    current.dispatchStartedAt = dispatchStartedAt;
    current.lastStageObservedAt = dispatchStartedAt;
    try {
      worker.postMessage(request);
      current.stages.runPostMessageMs = Math.max(0, performance.now() - dispatchStartedAt);
    } catch (error) {
      this.fail(current, 'send', error instanceof Error ? error.message : 'The browser could not send the file to the engine.');
    }
  }

  private onWorkerMessage(current: ActiveRun, response: RunResponse) {
    if (this.active !== current || response.jobId !== current.jobId) return;
    this.observeWorkerEvent(current);
    if (response.type === 'output') {
      if (response.sequence <= current.lastOutputSequence) return;
      current.lastOutputSequence = response.sequence;
      const text = current.decoders[response.stream].decode(response.chunk, { stream: true });
      if (text) this.append(current, { stream: response.stream, text });
      return;
    }
    if (response.type === 'progress') {
      this.updateWorkerProgress(current, response.progress);
      return;
    }
    if (response.type === 'input-needed') {
      if (current.inputEnded || response.requestId <= current.lastRequestId || current.inputRequestId !== null) return;
      this.updateWorkerProgress(current, response.progress);
      current.lastRequestId = response.requestId;
      if (!this.pauseWatchdog(current)) return;
      current.inputRequestId = response.requestId;
      this.publish({ status: 'running', document: current.document, transcript: this.currentState.transcript, inputRequestId: response.requestId });
      return;
    }
    if (response.type === 'result') {
      const transcript = this.flushDecoders(current);
      const summary = formatResultSummary(response.result, current.sourceSnapshot);
      const completeTranscript = summary
        ? addSystemEntry(transcript, summary.text, summary.tone, {
          copyable: summary.copyable,
          diagnosticLocations: summary.diagnosticLocations,
        })
        : transcript;
      this.finish(current, {
        status: 'finished',
        document: current.document,
        sourceSnapshot: current.sourceSnapshot,
        result: response.result,
        transcript: completeTranscript,
      });
      return;
    }
    this.fail(current, response.phase === 'startup' ? 'start' : 'run', response.message);
  }

  sendStdinLine(line: string): boolean {
    const current = this.active;
    const requestId = current?.inputRequestId;
    if (!current || requestId === null || requestId === undefined || current.inputEnded) return false;
    const bytes = new TextEncoder().encode(`${line}\n`);
    current.inputRequestId = null;
    try {
      const command: WorkerCommand = { type: 'stdin', jobId: current.jobId, requestId, bytes };
      this.setObservedStage(current, RUN_DIAGNOSTIC_STAGE.stdinDispatch);
      current.worker.postMessage(command);
    } catch (error) {
      this.fail(current, 'send', error instanceof Error ? error.message : 'The browser could not send input to the engine.');
      return false;
    }
    const state = this.currentState;
    if (state.status === 'running') {
      this.publish({
        status: 'running',
        document: current.document,
        transcript: appendEntry(state.transcript, { stream: 'stdin', text: `${line}\n` }),
        inputRequestId: null,
      });
    }
    this.armWatchdog(current);
    return true;
  }

  sendStdinEOF(): boolean {
    const current = this.active;
    const requestId = current?.inputRequestId;
    if (!current || requestId === null || requestId === undefined || current.inputEnded) return false;
    current.inputRequestId = null;
    current.inputEnded = true;
    try {
      const command: WorkerCommand = { type: 'stdin-eof', jobId: current.jobId, requestId };
      this.setObservedStage(current, RUN_DIAGNOSTIC_STAGE.stdinDispatch);
      current.worker.postMessage(command);
    } catch (error) {
      this.fail(current, 'send', error instanceof Error ? error.message : 'The browser could not send end of input to the engine.');
      return false;
    }
    const state = this.currentState;
    if (state.status === 'running') {
      this.publish({
        status: 'running',
        document: current.document,
        transcript: appendEntry(state.transcript, { stream: 'system', text: '[EOF]\n', role: 'input' }),
        inputRequestId: null,
      });
    }
    this.armWatchdog(current);
    return true;
  }

  stop(): void {
    const current = this.active;
    if (!current) return;
    const transcript = addSystemEntry(this.flushDecoders(current), 'Execution cancelled by the user.', 'warning');
    this.finish(current, { status: 'cancelled', document: current.document, transcript });
  }

  dispose(): void {
    const current = this.active;
    if (!current) return;
    this.active = null;
    closeRun(current);
  }
}
