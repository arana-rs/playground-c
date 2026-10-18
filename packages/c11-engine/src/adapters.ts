import { execute, prepare } from './core/index.ts';
import type {
    Diagnostic,
    EngineMetrics,
    ExecuteOptions,
    ExecuteResult,
    ExecutionOutput,
    PrepareOptions,
    PrepareResult,
    SourceProject,
} from './core/index.ts';

/** Limits for each engine stage, plus cooperative adapter cancellation. */
export interface RunOptions {
    prepare?: PrepareOptions;
    execute?: ExecuteOptions;
    signal?: AbortSignal;
}

/** Engine timings exclude file I/O and adapter overhead. */
export interface RunMetrics extends EngineMetrics {
    readMs: number;
    totalMs: number;
}

type RunStageResult<T> = T extends { metrics: EngineMetrics }
    ? Omit<T, 'metrics'> & { metrics: RunMetrics }
    : never;

export type RunResult = RunStageResult<
    Exclude<PrepareResult, { kind: 'prepared' }> | ExecuteResult
> | {
    kind: 'read-error';
    diagnostics: readonly Diagnostic[];
    metrics: RunMetrics;
} | ({
    kind: 'cancelled';
    stage: 'read' | 'prepare';
    diagnostics: readonly Diagnostic[];
    metrics: RunMetrics;
}) | ({
    kind: 'cancelled';
    stage: 'execute';
    diagnostics: readonly Diagnostic[];
    metrics: RunMetrics;
} & ExecutionOutput);

const emptyEngineMetrics = (): EngineMetrics => ({
    prepareMs: 0,
    executeMs: 0,
    sourceChars: 0,
    tokenCount: 0,
    preprocessSteps: 0,
    instructionCount: 0,
    peakMemoryBytes: 0,
});

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function runProjectStarted(
    project: SourceProject,
    options: RunOptions,
    startedAt: number,
    readMs: number,
): RunResult {
    const name = typeof project?.entry === 'string' && project.entry ? project.entry : 'main.c';
    let engineMetrics = emptyEngineMetrics();
    const metrics = (): RunMetrics => ({
        ...engineMetrics,
        readMs,
        totalMs: performance.now() - startedAt,
    });
    const cancellationDiagnostic = (): Diagnostic => ({
            code: 'CANCELLED',
            message: 'Execution was cancelled before the stage started.',
            file: name,
            line: 1,
            column: 1,
    });
    const cancelled = (stage: 'prepare' | 'execute'): RunResult => ({
        kind: 'cancelled', stage, diagnostics: [cancellationDiagnostic()], metrics: metrics(),
        ...(stage === 'execute' ? { stdout: new Uint8Array(), stderr: new Uint8Array() } : {}),
    } as RunResult);

    if (options.signal?.aborted) return cancelled('prepare');
    const preparation = prepare(project, options.prepare);
    engineMetrics = preparation.metrics;
    if (preparation.kind !== 'prepared') {
        return { ...preparation, metrics: metrics() };
    }
    if (options.signal?.aborted) return cancelled('execute');

    const execution = execute(preparation.program, options.execute);
    engineMetrics = {
        ...execution.metrics,
        prepareMs: preparation.metrics.prepareMs,
        sourceChars: preparation.metrics.sourceChars,
        tokenCount: preparation.metrics.tokenCount,
    };
    return { ...execution, metrics: metrics() };
}

/** Run a fully supplied virtual project. This layer never reads host files. */
export async function runProject(project: SourceProject, options: RunOptions = {}): Promise<RunResult> {
    return runProjectStarted(project, options, performance.now(), 0);
}

/** Shared read/prepare/execute orchestration; only the caller supplies host reads. */
export async function runRead(
    name: string,
    read: () => Promise<string>,
    options: RunOptions = {},
): Promise<RunResult> {
    const startedAt = performance.now();
    if (options.signal?.aborted) {
        const engineMetrics = emptyEngineMetrics();
        return {
            kind: 'cancelled', stage: 'read', diagnostics: [{
                code: 'CANCELLED', message: 'Reading was cancelled before it started.', file: name, line: 1, column: 1,
            }],
            metrics: { ...engineMetrics, readMs: 0, totalMs: performance.now() - startedAt },
        };
    }
    let source: string;
    const readStartedAt = performance.now();
    try {
        source = await read();
    } catch (error) {
        const readMs = performance.now() - readStartedAt;
        const engineMetrics = emptyEngineMetrics();
        if (options.signal?.aborted) {
            return {
                kind: 'cancelled', stage: 'read', diagnostics: [{
                    code: 'CANCELLED', message: 'Reading was cancelled.', file: name, line: 1, column: 1,
                }],
                metrics: { ...engineMetrics, readMs, totalMs: performance.now() - startedAt },
            };
        }
        return {
            kind: 'read-error',
            diagnostics: [{ code: 'READ_FAILED', message: `Could not read «${name}»: ${describeError(error)}`, file: name, line: 1, column: 1 }],
            metrics: { ...engineMetrics, readMs, totalMs: performance.now() - startedAt },
        };
    }
    const readMs = performance.now() - readStartedAt;
    return runProjectStarted({ entry: name, files: [{ name, source }] }, options, startedAt, readMs);
}
