import { useCallback, useEffect, useRef, useState } from 'react';
import type { Diagnostic, RunResult } from '@playground/c11-engine/browser';
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
import { RUN_CONFIGURATION } from './configuration.ts';
import { formatDiagnosticLocation } from './diagnosticFormatting.ts';
import type { RunConfiguration } from './configuration.ts';

export { RUN_CONFIGURATION } from './configuration.ts';
export type { RunConfiguration } from './configuration.ts';
export type { RunDiagnosticsReport } from './diagnostics.ts';

export type ConsoleSystemTone = 'system' | 'warning' | 'error';
export type ConsoleOutputTone = 'program' | ConsoleSystemTone;

export type ConsoleEntry =
  | { stream: 'stdout' | 'stderr' | 'stdin'; text: string }
  | { stream: 'system'; text: string; tone?: ConsoleSystemTone; role?: 'input' | 'protected' };

export interface ConsoleOutputSegment {
  tone: ConsoleOutputTone;
  text: string;
  role?: 'output' | 'input' | 'protected';
  stream?: ConsoleEntry['stream'];
}

export type RunnerState =
  | { status: 'idle'; transcript: readonly ConsoleEntry[] }
  | { status: 'running'; transcript: readonly ConsoleEntry[]; inputRequestId: number | null }
  | { status: 'cancelled'; transcript: readonly ConsoleEntry[] }
  | { status: 'finished'; result: RunResult; transcript: readonly ConsoleEntry[] }
  | { status: 'error'; file: string; reason: 'start' | 'run' | 'response' | 'send'; message: string; transcript: readonly ConsoleEntry[] }
  | { status: 'timeout'; file: string; timeoutMs: number; diagnosticsReport: RunDiagnosticsReport; transcript: readonly ConsoleEntry[] };

export type ConsoleStatusTone = 'ready' | 'running' | 'waiting' | 'finished' | 'stopped' | 'cancelled' | 'error';
export type ConsoleStatusKey = 'ready' | 'running' | 'waitingInput' | 'cancelled' | 'error' | 'timedOut' | 'stopped' | 'finished';

export interface ConsoleStatus {
  key: ConsoleStatusKey;
  tone: ConsoleStatusTone;
}

/** A display key and tone derived directly from the runner's current state. */
export function getConsoleStatus(state: RunnerState): ConsoleStatus {
  if (state.status === 'idle') return { key: 'ready', tone: 'ready' };
  if (state.status === 'running') {
    return state.inputRequestId == null
      ? { key: 'running', tone: 'running' }
      : { key: 'waitingInput', tone: 'waiting' };
  }
  if (state.status === 'cancelled') return { key: 'cancelled', tone: 'cancelled' };
  if (state.status === 'error') return { key: 'error', tone: 'error' };
  if (state.status === 'timeout') return { key: 'timedOut', tone: 'stopped' };

  switch (state.result.kind) {
    case 'cancelled': return { key: 'cancelled', tone: 'cancelled' };
    case 'limit': return { key: 'stopped', tone: 'stopped' };
    case 'prepare-error':
    case 'read-error':
    case 'runtime-error': return { key: 'error', tone: 'error' };
    case 'terminated': return { key: 'finished', tone: 'finished' };
  }
}

interface ActiveRun {
  jobId: number;
  worker: Worker;
  configuration: RunConfiguration;
  startedAt: number;
  fileName: string;
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

function appendEntry(transcript: readonly ConsoleEntry[], entry: ConsoleEntry): readonly ConsoleEntry[] {
  const previous = transcript.at(-1);
  if (previous?.stream === entry.stream && entry.stream !== 'stdin' && entry.stream !== 'system') {
    return [...transcript.slice(0, -1), { stream: entry.stream, text: previous.text + entry.text }];
  }
  return [...transcript, entry];
}

function appendOutputSegment(
  segments: ConsoleOutputSegment[],
  text: string,
  tone: ConsoleOutputTone,
  role: ConsoleOutputSegment['role'] = 'output',
  stream?: ConsoleOutputSegment['stream'],
) {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.tone === tone && previous.role === role && previous.stream === stream) previous.text += text;
  else segments.push({ tone, text, role, stream });
}

function appendOutputSection(
  segments: ConsoleOutputSegment[],
  next: { tone: ConsoleOutputTone; text: string; role?: ConsoleOutputSegment['role']; stream?: ConsoleOutputSegment['stream'] },
) {
  if (!next.text) return;
  const previous = segments.at(-1);
  const separator = previous && !previous.text.endsWith('\n') ? '\n' : '';
  appendOutputSegment(segments, `${separator}${next.text}`, next.tone, next.role, next.stream);
}

function formatTranscriptSegments(transcript: readonly ConsoleEntry[]): ConsoleOutputSegment[] {
  const segments: ConsoleOutputSegment[] = [];
  for (const entry of transcript) {
    if (entry.stream === 'stderr') {
      appendOutputSegment(segments, entry.text, 'program', 'output', 'stderr');
    } else {
      const tone = entry.stream === 'system' ? entry.tone ?? 'system' : 'program';
      const role = entry.stream === 'system' ? entry.role ?? 'protected' : entry.stream === 'stdin' ? 'input' : 'output';
      appendOutputSegment(segments, entry.text, tone, role, entry.stream);
    }
  }
  return segments;
}

function addSystemEntry(
  transcript: readonly ConsoleEntry[],
  message: string,
  tone: ConsoleSystemTone = 'system',
): readonly ConsoleEntry[] {
  const current = transcript.at(-1)?.text ?? '';
  const separator = transcript.length > 0 && current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  return appendEntry(transcript, { stream: 'system', text: `${separator}${message}`, tone });
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

function errorText(file: string, reason: 'start' | 'run' | 'response' | 'send', message: string): string {
  const quotedFile = `"${file}"`;
  if (reason === 'start') return `Could not start the execution engine for ${quotedFile}: ${message}`;
  if (reason === 'response') return `The engine finished, but its response for ${quotedFile} could not be read: ${message}`;
  if (reason === 'send') return `Could not send ${quotedFile} to the execution engine: ${message}`;
  return `The execution engine failed while processing ${quotedFile}: ${message}`;
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
      `The ${formatDuration(current.configuration.timeoutMs)} time limit expired while starting, reading, preparing, or running "${current.fileName}"; execution stopped. Check for slow code such as loops or recursion. A valid program may also need more time.`,
      'warning',
    );
    this.finish(current, {
      status: 'timeout',
      file: current.fileName,
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
      file: {
        name: current.fileName,
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
    const transcript = addSystemEntry(this.flushDecoders(current), errorText(current.fileName, reason, message), 'error');
    this.finish(current, { status: 'error', file: current.fileName, reason, message, transcript });
  }

  run(file: File, configuration: RunConfiguration = this.configuration): void {
    if (this.active) return;
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
        status: 'error', file: file.name, reason: 'start', message,
        transcript: [{ stream: 'system', text: errorText(file.name, 'start', message), tone: 'error' }],
      });
      return;
    }

    const current: ActiveRun = {
      jobId,
      worker,
      configuration,
      startedAt,
      fileName: file.name,
      fileSizeBytes: file.size,
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
    this.publish({ status: 'running', transcript: [], inputRequestId: null });

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
    const request: RunRequest = { type: 'run', jobId, file, options: configuration.options };
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
      this.publish({ status: 'running', transcript: this.currentState.transcript, inputRequestId: response.requestId });
      return;
    }
    if (response.type === 'result') {
      const transcript = this.flushDecoders(current);
      const summary = formatResultSummary(response.result);
      const completeTranscript = summary ? addSystemEntry(transcript, summary.text, summary.tone) : transcript;
      this.finish(current, { status: 'finished', result: response.result, transcript: completeTranscript });
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
    this.finish(current, { status: 'cancelled', transcript });
  }

  dispose(): void {
    const current = this.active;
    if (!current) return;
    this.active = null;
    closeRun(current);
  }
}

export function useRunner(configuration: RunConfiguration = RUN_CONFIGURATION) {
  const controller = useRef<RunnerController | null>(null);
  if (!controller.current) controller.current = new RunnerController(configuration);
  const runner = controller.current;
  const [state, setState] = useState<RunnerState>(runner.state);

  useEffect(() => {
    setState(runner.state);
    return runner.subscribe(setState);
  }, [runner]);
  useEffect(() => () => runner.dispose(), [runner]);

  const run = useCallback((file: File, configuration?: RunConfiguration) => runner.run(file, configuration), [runner]);
  const stop = useCallback(() => runner.stop(), [runner]);
  const sendStdinLine = useCallback((line: string) => runner.sendStdinLine(line), [runner]);
  const sendStdinEOF = useCallback(() => runner.sendStdinEOF(), [runner]);

  return { state, run, stop, sendStdinLine, sendStdinEOF, isRunning: state.status === 'running' };
}

function formatDiagnostic(item: Diagnostic) {
  return `${formatDiagnosticLocation(item)}: ${item.message}`;
}

function formatLocation(item: Diagnostic) {
  return formatDiagnosticLocation(item);
}

function appendConsoleSection(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  return `${current}${current.endsWith('\n') ? '' : '\n'}${next}`;
}

function formatOutputSegments(result: RunResult): ConsoleOutputSegment[] {
  const segments: ConsoleOutputSegment[] = [];
  if ('stdout' in result) appendOutputSegment(segments, new TextDecoder().decode(result.stdout), 'program', 'output', 'stdout');
  if ('stderr' in result) {
    const stderr = new TextDecoder().decode(result.stderr);
    appendOutputSegment(segments, stderr, 'program', 'output', 'stderr');
  }
  return segments;
}

type LimitRunResult = Extract<RunResult, { kind: 'limit' }>;
type LimitResource = LimitRunResult['resource'];

const limitDescriptions: Record<LimitResource, { label: string; unit: string; reason: string }> = {
  maxSourceChars: {
    label: 'source code size',
    unit: 'characters',
    reason: 'This limit bounds reading and preparation of large files.',
  },
  maxTokens: {
    label: 'analyzed code size',
    unit: 'tokens',
    reason: 'This limit bounds analysis of large programs.',
  },
  maxPreprocessSteps: {
    label: 'preprocessor work',
    unit: 'steps',
    reason: 'A large macro or include expansion can reach this limit.',
  },
  maxDepth: {
    label: 'nesting depth',
    unit: 'levels',
    reason: 'Check for deeply nested expressions, blocks, or calls; this limit alone does not identify the cause.',
  },
  maxInstructions: {
    label: 'execution steps',
    unit: 'steps',
    reason: 'Check for long loops or recursion; a valid calculation can also exceed this budget.',
  },
  maxMemoryBytes: {
    label: 'program memory',
    unit: 'bytes',
    reason: 'This budget protects the playground from large data or objects.',
  },
  maxIOBytes: {
    label: 'input and output data',
    unit: 'bytes',
    reason: 'This budget covers data that the program can read and write.',
  },
};

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatDuration(milliseconds: number) {
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds) ? `${formatCount(seconds)} s` : `${formatCount(milliseconds)} ms`;
}

function limitUsage(result: LimitRunResult): number | undefined {
  switch (result.resource) {
    case 'maxSourceChars': return result.metrics.sourceChars;
    case 'maxTokens': return result.metrics.tokenCount;
    case 'maxPreprocessSteps': return result.metrics.preprocessSteps;
    case 'maxInstructions': return result.metrics.instructionCount;
    default: return undefined;
  }
}

function formatLimit(result: LimitRunResult) {
  const description = limitDescriptions[result.resource];
  const stage = result.stage === 'prepare' ? 'Preparation stopped' : 'Execution stopped';
  const usage = limitUsage(result);
  const counts = usage === undefined || usage <= result.limit
    ? `${formatCount(result.limit)} ${description.unit} allowed`
    : `${formatCount(result.limit)} ${description.unit} allowed; ${formatCount(usage)} were counted`;
  const locations = result.diagnostics.map(formatLocation).join('\n');
  return appendConsoleSection(
    `${stage}: the ${description.label} limit was reached (${counts}). ${description.reason}`,
    locations,
  );
}

interface ConsoleSystemMessage {
  tone: ConsoleSystemTone;
  text: string;
}

function formatResultSummary(result: RunResult): ConsoleSystemMessage {
  if (result.kind === 'terminated') {
    return { tone: 'system', text: `exit code: ${result.exitCode}` };
  }
  if (result.kind === 'cancelled') {
    return { tone: 'warning', text: `Execution was cancelled during the ${result.stage} stage.` };
  }
  if (result.kind === 'limit') {
    return { tone: 'warning', text: formatLimit(result) };
  }
  if (result.kind === 'runtime-error') {
    return {
      tone: 'error',
      text: appendConsoleSection('Runtime error:', result.diagnostics.map(formatDiagnostic).join('\n')),
    };
  }
  if (result.kind === 'prepare-error') {
    return {
      tone: 'error',
      text: appendConsoleSection('Could not prepare the program:', result.diagnostics.map(formatDiagnostic).join('\n')),
    };
  }
  return {
    tone: 'error',
    text: appendConsoleSection('Could not read the file for execution:', result.diagnostics.map(formatDiagnostic).join('\n')),
  };
}

export function formatConsoleSegments(state: RunnerState): readonly ConsoleOutputSegment[] {
  if (state.status === 'idle') return [];
  const transcript = 'transcript' in state ? state.transcript : undefined;
  if (transcript?.length) return formatTranscriptSegments(transcript);
  if (state.status === 'running') return [];
  if (state.status === 'cancelled') return [{ tone: 'warning', text: 'Execution cancelled by the user.', role: 'protected', stream: 'system' }];
  if (state.status === 'error') {
    return [{ tone: 'error', text: errorText(state.file, state.reason, state.message), role: 'protected', stream: 'system' }];
  }
  if (state.status === 'timeout') {
    return [{
      tone: 'warning',
      role: 'protected',
      stream: 'system',
      text: `The ${formatDuration(state.timeoutMs)} time limit expired while starting, reading, preparing, or running "${state.file}"; execution stopped. Check for slow code such as loops or recursion. A valid program may also need more time.`,
    }];
  }
  const segments = formatOutputSegments(state.result);
  const summary = formatResultSummary(state.result);
  appendOutputSection(segments, { ...summary, role: 'protected', stream: 'system' });
  return segments;
}

export function formatConsole(state: RunnerState): string {
  let text = '';
  for (const segment of formatConsoleSegments(state)) {
    if (segment.role === 'output' && segment.stream === 'stderr' && segment.text) {
      const separator = text && !text.endsWith('\n') ? '\n' : '';
      text += `${separator}stderr:\n${segment.text}`;
    } else {
      text += segment.text;
    }
  }
  return text;
}
