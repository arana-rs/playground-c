export const RUN_DIAGNOSTIC_STAGE = {
  workerStartup: 'worker-startup',
  sourceRead: 'source-read',
  prepare: 'prepare',
  execute: 'execute',
  stdinWait: 'stdin-wait',
  stdinDispatch: 'stdin-dispatch',
} as const;

export type RunDiagnosticStage = typeof RUN_DIAGNOSTIC_STAGE[keyof typeof RUN_DIAGNOSTIC_STAGE];

export interface RunDiagnosticStages {
  /** Synchronous Worker constructor call in the parent; module startup is in dispatchToFirstWorkerEventMs. */
  workerCreateMs: number | null;
  /** Synchronous duration of the parent's `postMessage(run)` call. */
  runPostMessageMs: number | null;
  /** Parent-local send-to-first-message duration; includes observable boot/queue/transport and can overlap source reading. */
  dispatchToFirstWorkerEventMs: number | null;
  /** Worker-local duration of File.text(), once it resolves or rejects. */
  sourceReadMs: number | null;
  /** Engine preparation duration, available after `prepare` returns. */
  prepareMs: number | null;
  /** Cumulative engine time inside completed `resume()` calls; may be partial if the current call hangs. */
  executeActiveMs: number | null;
  /** Worker-local cumulative stdin wait, published after the next input arrives. */
  stdinWaitMs: number | null;
  /** Worker elapsed time at the latest progress snapshot; can be stale if it later blocks. */
  workerTotalMs: number | null;
  /** Parent watchdog active time; pauses while the UI awaits stdin. */
  watchdogActiveMs: number | null;
  /** Parent-local total from beginning Worker creation to timeout; includes stdin waits. */
  mainTotalObservedMs: number | null;
  /** Parent-local time since the last received stage marker, or run dispatch while awaiting the first message. */
  lastStageObservedMs: number | null;
}

export type RunDiagnosticTimingKey = keyof RunDiagnosticStages;
export const RUN_DIAGNOSTIC_TIMING_KEYS = [
  'workerCreateMs',
  'runPostMessageMs',
  'dispatchToFirstWorkerEventMs',
  'sourceReadMs',
  'prepareMs',
  'executeActiveMs',
  'stdinWaitMs',
  'workerTotalMs',
  'watchdogActiveMs',
  'mainTotalObservedMs',
  'lastStageObservedMs',
] as const satisfies readonly RunDiagnosticTimingKey[];

export interface RunDiagnosticMetrics {
  /** Preparation snapshots remain owned by `prepare`; execution counters are the latest completed `resume()` snapshot. */
  sourceChars: number | null;
  tokenCount: number | null;
  preprocessSteps: number | null;
  instructionCount: number | null;
  peakMemoryBytes: number | null;
}

export interface RunDiagnosticBudgets {
  uiWatchdogMs: number;
  prepare: {
    maxSourceChars: number | null;
    maxTokens: number | null;
    maxPreprocessSteps: number | null;
    maxDepth: number | null;
  };
  execute: {
    maxInstructions: number | null;
    maxMemoryBytes: number | null;
    maxIOBytes: number | null;
    maxDepth: number | null;
  };
}

export interface RunDiagnosticsReport {
  schemaVersion: 1;
  outcome: 'timeout';
  reason: 'ui-watchdog';
  file: {
    name: string;
    sizeBytes: number;
    lineCount: number | null;
  };
  budgets: RunDiagnosticBudgets;
  stages: RunDiagnosticStages;
  lastStage: RunDiagnosticStage;
  metrics: RunDiagnosticMetrics;
  diagnostic: {
    code: 'RUN_TIMEOUT_UI';
    message: string;
  };
}

export interface RunWorkerProgress {
  stage: Exclude<RunDiagnosticStage, 'worker-startup' | 'stdin-dispatch'>;
  sourceLineCount?: number;
  stages?: Partial<Pick<RunDiagnosticStages,
    'sourceReadMs' | 'prepareMs' | 'executeActiveMs' | 'stdinWaitMs' | 'workerTotalMs'>>;
  metrics?: Partial<RunDiagnosticMetrics>;
}

export function emptyRunDiagnosticStages(): RunDiagnosticStages {
  return {
    workerCreateMs: null,
    runPostMessageMs: null,
    dispatchToFirstWorkerEventMs: null,
    sourceReadMs: null,
    prepareMs: null,
    executeActiveMs: null,
    stdinWaitMs: null,
    workerTotalMs: null,
    watchdogActiveMs: null,
    mainTotalObservedMs: null,
    lastStageObservedMs: null,
  };
}

export function emptyRunDiagnosticMetrics(): RunDiagnosticMetrics {
  return {
    sourceChars: null,
    tokenCount: null,
    preprocessSteps: null,
    instructionCount: null,
    peakMemoryBytes: null,
  };
}
