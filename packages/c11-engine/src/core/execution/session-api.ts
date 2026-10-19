import type { DebugProgress, ExecuteProgress } from '../types.ts';
import type { RuntimeSession } from './runtime-types.ts';
import type { RuntimeSessionApiContext } from './session-api-context.ts';

/** Build the public session facade without starting or advancing the VM. */
export function createRuntimeSessionApi(context: RuntimeSessionApiContext): RuntimeSession {
  const session: RuntimeSession = {
    resume(): ExecuteProgress | DebugProgress {
      if (context.terminalResult) return { ...context.terminalResult, metrics: { ...context.metrics }, ...context.output() };
      if (context.awaitingInput) {
        const waiting = { kind: 'input-needed' as const, ...context.output(), metrics: { ...context.metrics } };
        if (context.debugOptions === undefined) return waiting;
        const current = context.exposedDebugLocation() ?? context.runtimeLocation;
        return {
          ...waiting,
          location: Object.freeze({ file: current.file, line: current.line, column: current.column }),
        };
      }
      const resumeStarted = context.now();
      if (context.debugOptions !== undefined) {
        context.debugPause = undefined;
        if (!context.debugInputSuspended) {
          context.debugStepStartLocation = context.debugLocation ?? undefined;
          context.debugStepExecuted = false;
          context.debugVisitedInstructions = new Map();
          context.debugStepActive = context.debugLocation !== null;
        }
      }
      try {
        const runRuntime = context.runRuntime;
        if (context.pendingInputError !== undefined) {
          const error = context.pendingInputError;
          context.pendingInputError = undefined;
          context.terminalResult = context.resultForError(error);
        } else if (!runRuntime) {
          context.terminalResult = context.resultForError(new Error('The session was not initialized.'));
        } else {
          const progress = runRuntime();
          if (progress.kind === 'paused') {
            context.debugInputSuspended = false;
            context.metrics.executeMs += context.now() - resumeStarted;
            return { ...progress, metrics: { ...context.metrics } };
          }
          if (progress.kind === 'input-needed' && context.debugOptions !== undefined) {
            const current = context.exposedDebugLocation() ?? context.runtimeLocation;
            context.debugInputSuspended = true;
            context.metrics.executeMs += context.now() - resumeStarted;
            return {
              ...progress,
              location: Object.freeze({ file: current.file, line: current.line, column: current.column }),
              metrics: { ...context.metrics },
            };
          }
          if (progress.kind !== 'input-needed') context.terminalResult = progress;
          if (context.terminalResult) {
            context.debugLocation = null;
            context.debugInputSuspended = false;
            context.io?.closeTemporaryFiles();
          }
          context.metrics.executeMs += context.now() - resumeStarted;
          if (context.terminalResult) return { ...context.terminalResult, metrics: { ...context.metrics } };
          return { ...progress, metrics: { ...context.metrics }, ...context.output() };
        }
      } catch (error) {
        context.terminalResult = context.resultForError(error);
        context.debugLocation = null;
        context.debugInputSuspended = false;
      }
      if (context.terminalResult) context.io?.closeTemporaryFiles();
      context.metrics.executeMs += context.now() - resumeStarted;
      return { ...context.terminalResult!, metrics: { ...context.metrics }, ...context.output() };
    },
  };

  if (context.interactiveStdin) {
    session.appendStdin = (bytes: Uint8Array): void => {
      if (!context.interactiveStdin) throw new TypeError('Batch sessions do not accept interactive stdin.');
      if (context.terminalResult || context.stdinEnded) throw new TypeError('Cannot append stdin after EOF or execution has finished.');
      if (!context.awaitingInput) throw new TypeError('stdin can only be appended after the session requests it.');
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Interactive stdin must be a Uint8Array.');
      try {
        context.io!.appendStdin(bytes, context.runtimeLocation);
        context.awaitingInput = false;
      } catch (error) {
        context.pendingInputError = error;
        context.awaitingInput = false;
      }
    };
    session.endStdin = (): void => {
      if (!context.interactiveStdin) throw new TypeError('Batch sessions do not accept interactive stdin.');
      if (context.terminalResult) throw new TypeError('Cannot close stdin after execution has finished.');
      if (context.stdinEnded) return;
      context.stdinEnded = true;
      context.awaitingInput = false;
      context.io?.endStdin();
    };
  }
  if (context.debugOptions !== undefined) {
    session.drainEvents = () => context.debugEvents?.drain() ?? Object.freeze([]);
    session.currentLocation = context.exposedDebugLocation;
    session.inspectScalars = () => context.inspectDebugScalars?.() ?? Object.freeze([]);
    session.inspectPointers = () => context.inspectDebugPointers?.() ?? Object.freeze([]);
    session.inspectStaticObjects = (inspectionOptions) => context.inspectDebugStaticObjects?.(inspectionOptions) ?? Object.freeze([]);
    session.inspectArrays = () => context.inspectDebugArrays?.() ?? Object.freeze({ arrays: Object.freeze([]), omittedObjects: 0 });
    session.inspectAggregates = () => context.inspectDebugAggregates?.() ?? Object.freeze({ aggregates: Object.freeze([]), omittedObjects: 0 });
    session.inspectHeapObjects = () => context.inspectDebugHeapObjects?.() ?? Object.freeze([]);
  }
  return session;
}
