import { createDebugSession, prepare } from '@playground/c11-engine/core';
import type {
  DebugExecutionSession,
  DebugAggregateInspection,
  DebugAggregateSnapshot,
  DebugArraySnapshot,
  DebugHeapObjectSnapshot,
  DebugPointerSnapshot,
  DebugProgress,
  DebugScalarSnapshot,
  DebugStaticObjectSnapshot,
  SourceProject,
} from '@playground/c11-engine/core';
import { RUN_CONFIGURATION } from '../execution/configuration.ts';
import type { MemoryViewerCommand, MemoryViewerResponse } from './protocol.ts';

interface DebugRun {
  jobId: number;
  session: DebugExecutionSession;
  lastRequestId: number;
  busy: boolean;
  finished: boolean;
  heapObjects: readonly DebugHeapObjectSnapshot[];
  pointers: readonly DebugPointerSnapshot[];
  arrays: readonly DebugArraySnapshot[];
  omittedArrayObjects: number;
  aggregates: readonly DebugAggregateSnapshot[];
  omittedAggregateObjects: number;
  stackScalars: readonly DebugScalarSnapshot[];
  staticObjects: readonly DebugStaticObjectSnapshot[];
}

let activeRun: DebugRun | null = null;

function post(response: MemoryViewerResponse) {
  self.postMessage(response);
}

function formatDiagnostics(diagnostics: readonly { file: string; line: number; column: number; message: string }[]) {
  return diagnostics.map(item => `${item.file}:${item.line}:${item.column}: ${item.message}`).join('\n');
}

function startupError(jobId: number, requestId: number | null, status: 'error' | 'limit', message: string) {
  if (activeRun?.jobId === jobId) activeRun = null;
  post({ type: 'debug-error', jobId, requestId, status, message });
}

/** Keep engine-owned immutable DTOs; some terminal sessions may no longer expose a stack. */
function inspectStackScalars(run: DebugRun): readonly DebugScalarSnapshot[] {
  try {
    run.stackScalars = run.session.inspectScalars();
  } catch {
    // Retain the last real inspection when the engine cannot inspect a terminal state.
  }
  return run.stackScalars;
}

/** Keep engine-owned immutable pointer snapshots if a terminal session cannot inspect them. */
function inspectPointers(run: DebugRun): readonly DebugPointerSnapshot[] {
  try {
    run.pointers = run.session.inspectPointers();
  } catch {
    // Retain the last real inspection when the engine cannot inspect a terminal state.
  }
  return run.pointers;
}

/** Keep engine-owned immutable DTOs when a terminal session can no longer expose the heap. */
function inspectHeapObjects(run: DebugRun): readonly DebugHeapObjectSnapshot[] {
  try {
    run.heapObjects = run.session.inspectHeapObjects();
  } catch {
    // Retain the last real inspection when the engine cannot inspect a terminal state.
  }
  return run.heapObjects;
}

/** Keep engine-owned immutable DTOs; terminal inspection may no longer expose static memory. */
function inspectStaticObjects(run: DebugRun): readonly DebugStaticObjectSnapshot[] {
  try {
    run.staticObjects = run.session.inspectStaticObjects({ includeStringLiterals: false });
  } catch {
    // Retain the last real inspection when the engine cannot inspect a terminal state.
  }
  return run.staticObjects;
}

/** Keep the latest immutable array DTOs; inspection does not read C values or mutate the VM. */
function inspectArrays(run: DebugRun): readonly DebugArraySnapshot[] {
  try {
    const inspection = run.session.inspectArrays();
    run.arrays = inspection.arrays;
    run.omittedArrayObjects = inspection.omittedObjects;
  } catch {
    // Retain the last real inspection when a terminal session cannot inspect static memory.
  }
  return run.arrays;
}

/** Keep the latest immutable aggregate DTOs; inspection does not read C values or mutate the VM. */
function inspectAggregates(run: DebugRun): readonly DebugAggregateSnapshot[] {
  try {
    const inspection: DebugAggregateInspection = run.session.inspectAggregates();
    run.aggregates = inspection.aggregates;
    run.omittedAggregateObjects = inspection.omittedObjects;
  } catch {
    // Retain the last real inspection when a terminal session cannot inspect static memory.
  }
  return run.aggregates;
}

function begin(command: Extract<MemoryViewerCommand, { type: 'debug-start' }>) {
  if (activeRun) return;
  const project: SourceProject = {
    entry: command.fileName,
    files: [{ name: command.fileName, source: command.source }],
  };

  try {
    const preparation = prepare(project, RUN_CONFIGURATION.options.prepare);
    if (preparation.kind !== 'prepared') {
      startupError(
        command.jobId,
        null,
        preparation.kind === 'limit' ? 'limit' : 'error',
        formatDiagnostics(preparation.diagnostics),
      );
      return;
    }

    const session = createDebugSession(
      preparation.program,
      RUN_CONFIGURATION.options.execute,
      RUN_CONFIGURATION.debug,
    );
    const run: DebugRun = {
      jobId: command.jobId,
      session,
      lastRequestId: 0,
      busy: false,
      finished: false,
      heapObjects: [],
      pointers: [],
      arrays: [],
      omittedArrayObjects: 0,
      aggregates: [],
      omittedAggregateObjects: 0,
      stackScalars: [],
      staticObjects: [],
    };
    activeRun = run;
    const location = session.currentLocation();
    if (location) {
      post({
        type: 'debug-ready', jobId: command.jobId, location,
        hasHeapAllocationCalls: preparation.program.hasHeapAllocationCalls,
        events: session.drainEvents(),
        heapObjects: inspectHeapObjects(run),
        pointers: inspectPointers(run),
        arrays: inspectArrays(run),
        omittedArrayObjects: run.omittedArrayObjects,
        aggregates: inspectAggregates(run),
        omittedAggregateObjects: run.omittedAggregateObjects,
        stackScalars: inspectStackScalars(run),
        staticObjects: inspectStaticObjects(run),
      });
      return;
    }

    // A null location means setup already failed or the session is terminal. resume() reports that result.
    const progress = session.resume();
    run.finished = progress.kind !== 'paused';
    post({
      type: 'debug-progress', jobId: command.jobId, requestId: null,
      progress, events: session.drainEvents(),
      heapObjects: inspectHeapObjects(run),
      pointers: inspectPointers(run),
      arrays: inspectArrays(run),
      omittedArrayObjects: run.omittedArrayObjects,
      aggregates: inspectAggregates(run),
      omittedAggregateObjects: run.omittedAggregateObjects,
      stackScalars: inspectStackScalars(run),
      staticObjects: inspectStaticObjects(run),
    });
  } catch (error) {
    startupError(command.jobId, null, 'error', error instanceof Error ? error.message : 'No se pudo iniciar el visor de memoria.');
  }
}

function step(command: Extract<MemoryViewerCommand, { type: 'debug-step' }>) {
  const run = activeRun;
  if (!run || run.jobId !== command.jobId || run.finished || run.busy || command.requestId !== run.lastRequestId + 1) return;
  run.lastRequestId = command.requestId;
  run.busy = true;
  try {
    const progress: DebugProgress = run.session.resume();
    run.finished = progress.kind !== 'paused';
    post({
      type: 'debug-progress', jobId: command.jobId, requestId: command.requestId,
      progress, events: run.session.drainEvents(),
      heapObjects: inspectHeapObjects(run),
      pointers: inspectPointers(run),
      arrays: inspectArrays(run),
      omittedArrayObjects: run.omittedArrayObjects,
      aggregates: inspectAggregates(run),
      omittedAggregateObjects: run.omittedAggregateObjects,
      stackScalars: inspectStackScalars(run),
      staticObjects: inspectStaticObjects(run),
    });
  } catch (error) {
    run.finished = true;
    post({
      type: 'debug-error', jobId: command.jobId, requestId: command.requestId, status: 'error',
      message: error instanceof Error ? error.message : 'El motor no pudo completar el paso.',
    });
  } finally {
    run.busy = false;
  }
}

self.onmessage = (event: MessageEvent<MemoryViewerCommand>) => {
  const command = event.data;
  if (command.type === 'debug-start') begin(command);
  else step(command);
};
