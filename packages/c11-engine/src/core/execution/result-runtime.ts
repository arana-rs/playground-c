import { EngineFailure } from '../internal.ts';
import type { Location } from '../internal.ts';
import type {
  DebugLimitResult, DebugSessionOptions, DebugSourceLocation, EngineMetrics, ExecuteResult,
} from '../types.ts';
import { VirtualIOError } from '../virtual-io.ts';
import type { VirtualIO } from '../virtual-io.ts';
import { DebugEventLimit } from './debug-events.ts';

export interface ResultRuntimeContext {
  readonly debugOptions: DebugSessionOptions | undefined;
  readonly metrics: EngineMetrics;
  get io(): VirtualIO | undefined;
  get runtimeLocation(): Location;
  get debugLocation(): Location | null;
}

export interface ResultRuntime {
  readonly output: () => { stdout: Uint8Array; stderr: Uint8Array };
  readonly exposedDebugLocation: () => DebugSourceLocation | null;
  readonly resultForError: (error: unknown) => ExecuteResult | DebugLimitResult;
}

/** Format live output, debug location and execution failures for a session. */
export function createResultRuntime(context: ResultRuntimeContext): ResultRuntime {
  const output = () => context.io?.snapshot() ?? { stdout: new Uint8Array(), stderr: new Uint8Array() };
  const exposedDebugLocation = (): DebugSourceLocation | null => context.debugLocation
    ? Object.freeze({ file: context.debugLocation.file, line: context.debugLocation.line, column: context.debugLocation.column })
    : null;
  const resultForError = (error: unknown): ExecuteResult | DebugLimitResult => {
    if (error instanceof DebugEventLimit && context.debugOptions !== undefined) {
      return {
        kind: 'debug-limit', resource: 'maxDebugEvents', limit: error.limit,
        diagnostics: [{
          code: 'LIMIT_EXCEEDED', message: error.message,
          file: error.location.file, line: error.location.line, column: error.location.column,
        }],
        metrics: context.metrics, ...output(),
      };
    }
    if (error instanceof EngineFailure) {
      if (error.resource !== undefined && error.limit !== undefined) {
        return { kind: 'limit', stage: 'execute', resource: error.resource, limit: error.limit, diagnostics: [error.diagnostic], metrics: context.metrics, ...output() };
      }
      return { kind: 'runtime-error', diagnostics: [error.diagnostic], metrics: context.metrics, ...output() };
    }
    if (error instanceof VirtualIOError) {
      return {
        kind: 'runtime-error',
        diagnostics: [{ code: error.code, message: error.message, ...context.runtimeLocation }],
        metrics: context.metrics,
        ...output(),
      };
    }
    return {
      kind: 'runtime-error',
      diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'Execution encountered an internal engine error.', ...context.runtimeLocation }],
      metrics: context.metrics,
      ...output(),
    };
  };
  return { output, exposedDebugLocation, resultForError };
}
