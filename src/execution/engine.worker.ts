import { createExecutionSession, prepare } from '@playground/c11-engine/core';
import type { EngineMetrics, SourceProject } from '@playground/c11-engine/core';
import type { RunMetrics, RunResult } from '@playground/c11-engine/browser';
import { RUN_DIAGNOSTIC_STAGE } from './diagnostics.ts';
import type { RunDiagnosticMetrics, RunDiagnosticStage, RunWorkerProgress } from './diagnostics.ts';
import type { RunRequest, RunResponse, WorkerCommand } from './protocol.ts';
import { OutputSnapshotDeltas } from './outputSnapshotDeltas.ts';

interface WorkerRun {
  jobId: number;
  startedAt: number;
  readMs: number | null;
  session: ReturnType<typeof createExecutionSession> | null;
  waitingRequestId: number | null;
  nextRequestId: number;
  outputDeltas: OutputSnapshotDeltas;
  inputEnded: boolean;
  sourceLineCount: number | null;
  prepareMs: number | null;
  executeActiveMs: number | null;
  stdinWaitMs: number;
  stdinWaitStartedAt: number | null;
  diagnosticMetrics: RunDiagnosticMetrics;
}

let activeRun: WorkerRun | null = null;

const emptyMetrics = (): EngineMetrics => ({
  prepareMs: 0,
  executeMs: 0,
  sourceChars: 0,
  tokenCount: 0,
  preprocessSteps: 0,
  instructionCount: 0,
  peakMemoryBytes: 0,
});

function metricsWithTiming(metrics: EngineMetrics, run: WorkerRun): RunMetrics {
  return {
    ...metrics,
    readMs: run.readMs ?? 0,
    totalMs: performance.now() - run.startedAt,
  };
}

function post(response: RunResponse) {
  self.postMessage(response);
}

function diagnosticMetrics(metrics: EngineMetrics): RunDiagnosticMetrics {
  return {
    sourceChars: metrics.sourceChars,
    tokenCount: metrics.tokenCount,
    preprocessSteps: metrics.preprocessSteps,
    instructionCount: metrics.instructionCount,
    peakMemoryBytes: metrics.peakMemoryBytes,
  };
}

function mergeExecutionMetrics(previous: RunDiagnosticMetrics, metrics: EngineMetrics): RunDiagnosticMetrics {
  return {
    ...previous,
    instructionCount: metrics.instructionCount,
    peakMemoryBytes: metrics.peakMemoryBytes,
  };
}

function sourceLineCount(source: string): number {
  if (source.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  if (source.charCodeAt(source.length - 1) !== 10) lines += 1;
  return lines;
}

function progressSnapshot(run: WorkerRun, stage: RunWorkerProgress['stage']): RunWorkerProgress {
  const stages: NonNullable<RunWorkerProgress['stages']> = {
    stdinWaitMs: run.stdinWaitMs,
    workerTotalMs: performance.now() - run.startedAt,
  };
  if (run.readMs !== null) stages.sourceReadMs = run.readMs;
  if (run.prepareMs !== null) stages.prepareMs = run.prepareMs;
  if (run.executeActiveMs !== null) stages.executeActiveMs = run.executeActiveMs;

  return {
    stage,
    ...(run.sourceLineCount === null ? {} : { sourceLineCount: run.sourceLineCount }),
    stages,
    metrics: run.diagnosticMetrics,
  };
}

function reportProgress(run: WorkerRun, stage: RunDiagnosticStage) {
  if (activeRun !== run || stage === RUN_DIAGNOSTIC_STAGE.workerStartup || stage === RUN_DIAGNOSTIC_STAGE.stdinDispatch) return;
  post({ type: 'progress', jobId: run.jobId, progress: progressSnapshot(run, stage) });
}

function fail(run: WorkerRun, phase: 'startup' | 'run', message: string) {
  if (activeRun !== run) return;
  activeRun = null;
  post({ type: 'error', jobId: run.jobId, phase, message });
}

function reportStartupFailure(jobId: number, error: unknown) {
  const message = error instanceof Error ? error.message : 'No se pudo preparar ni iniciar el motor de ejecución.';
  const run = activeRun;
  if (run?.jobId === jobId) fail(run, 'startup', message);
  else post({ type: 'error', jobId, phase: 'startup', message });
}

function emitOutput(run: WorkerRun, stream: 'stdout' | 'stderr', snapshot: Uint8Array) {
  const delta = run.outputDeltas.fromSnapshot(stream, snapshot);
  if (delta) post({ type: 'output', jobId: run.jobId, ...delta });
}

function resume(run: WorkerRun) {
  const session = run.session;
  if (!session || activeRun !== run || run.waitingRequestId !== null) return;

  try {
    const progress = session.resume();
    run.executeActiveMs = progress.metrics.executeMs;
    // Preparation owns source/token/preprocessor counters. `resume()` reports
    // session metrics whose preparation fields are zero, so only merge the
    // execution counters from that snapshot.
    run.diagnosticMetrics = mergeExecutionMetrics(run.diagnosticMetrics, progress.metrics);
    emitOutput(run, 'stdout', progress.stdout);
    emitOutput(run, 'stderr', progress.stderr);
    if (progress.kind === 'input-needed') {
      const requestId = ++run.nextRequestId;
      run.waitingRequestId = requestId;
      run.stdinWaitStartedAt = performance.now();
      post({
        type: 'input-needed',
        jobId: run.jobId,
        requestId,
        progress: progressSnapshot(run, RUN_DIAGNOSTIC_STAGE.stdinWait),
      });
      return;
    }

    const result: RunResult = {
      ...progress,
      metrics: metricsWithTiming(progress.metrics, run),
    };
    activeRun = null;
    post({ type: 'result', jobId: run.jobId, result });
  } catch (error) {
    fail(run, 'run', error instanceof Error ? error.message : 'No se pudo ejecutar el archivo.');
  }
}

async function start(request: RunRequest) {
  if (activeRun) return;
  const run: WorkerRun = {
    jobId: request.jobId,
    startedAt: performance.now(),
    readMs: null,
    session: null,
    waitingRequestId: null,
    nextRequestId: 0,
    outputDeltas: new OutputSnapshotDeltas(),
    inputEnded: false,
    sourceLineCount: null,
    prepareMs: null,
    executeActiveMs: null,
    stdinWaitMs: 0,
    stdinWaitStartedAt: null,
    diagnosticMetrics: {
      sourceChars: null,
      tokenCount: null,
      preprocessSteps: null,
      instructionCount: null,
      peakMemoryBytes: null,
    },
  };
  activeRun = run;
  reportProgress(run, RUN_DIAGNOSTIC_STAGE.sourceRead);

  let source: string;
  const readStartedAt = performance.now();
  try {
    source = await request.file.text();
  } catch (error) {
    run.readMs = performance.now() - readStartedAt;
    const message = error instanceof Error ? error.message : String(error);
    const result: RunResult = {
      kind: 'read-error',
      diagnostics: [{
        code: 'READ_FAILED',
        message: `No se pudo leer «${request.file.name}»: ${message}`,
        file: request.file.name,
        line: 1,
        column: 1,
      }],
      metrics: metricsWithTiming(emptyMetrics(), run),
    };
    activeRun = null;
    post({ type: 'result', jobId: request.jobId, result });
    return;
  }
  run.readMs = performance.now() - readStartedAt;
  if (activeRun !== run) return;
  run.sourceLineCount = sourceLineCount(source);
  reportProgress(run, RUN_DIAGNOSTIC_STAGE.prepare);

  try {
    const project: SourceProject = {
      entry: request.file.name,
      files: [{ name: request.file.name, source }],
    };
    const preparation = prepare(project, request.options.prepare);
    if (preparation.kind !== 'prepared') {
      const result: RunResult = {
        ...preparation,
        metrics: metricsWithTiming(preparation.metrics, run),
      };
      activeRun = null;
      post({ type: 'result', jobId: request.jobId, result });
      return;
    }

    run.prepareMs = preparation.metrics.prepareMs;
    run.diagnosticMetrics = {
      ...diagnosticMetrics(preparation.metrics),
      instructionCount: null,
      peakMemoryBytes: null,
    };
    reportProgress(run, RUN_DIAGNOSTIC_STAGE.execute);
    run.session = createExecutionSession(preparation.program, request.options.execute);
    resume(run);
  } catch (error) {
    fail(
      run,
      'startup',
      error instanceof Error ? error.message : 'No se pudo preparar ni iniciar el motor de ejecución.',
    );
  }
}

function receiveInput(command: Extract<WorkerCommand, { type: 'stdin' | 'stdin-eof' }>) {
  const run = activeRun;
  if (!run || command.jobId !== run.jobId || run.waitingRequestId !== command.requestId || !run.session) return;
  if (run.inputEnded) return;
  if (run.stdinWaitStartedAt !== null) {
    run.stdinWaitMs += performance.now() - run.stdinWaitStartedAt;
    run.stdinWaitStartedAt = null;
  }
  run.waitingRequestId = null;

  if (command.type === 'stdin') run.session.appendStdin(command.bytes);
  else {
    run.inputEnded = true;
    run.session.endStdin();
  }
  reportProgress(run, RUN_DIAGNOSTIC_STAGE.execute);
  resume(run);
}

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  if (command.type === 'run') {
    void start(command).catch(error => reportStartupFailure(command.jobId, error));
    return;
  }
  receiveInput(command);
};
