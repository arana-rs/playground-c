import type {
  DebugAggregateInspection, DebugExecutionSession, DebugLimitResult,
  DebugPausedResult, DebugProgress, DebugSessionOptions, ExecuteOptions, ExecuteProgress,
  DebugArrayInspection, DebugHeapObjectSnapshot, DebugPointerSnapshot,
  DebugScalarSnapshot, DebugStaticObjectInspectionOptions, DebugStaticObjectSnapshot,
  ExecuteResult, ExecutionRuntimeServices, ExecutionSession, PreparedProgram,
} from './types.ts';
import { freshMetrics, now } from './internal.ts';
import type {
  Binding, CValue, Location,
} from './internal.ts';
import { hasVariableLengthBound, isPointer } from './type-system.ts';
import type { VirtualIO } from './virtual-io.ts';

import type {
  Evaluation, Frame, RuntimeSession,
} from './execution/runtime-types.ts';
import type { DebugEventCollector } from './execution/debug-events.ts';
import { debugTypeSummary } from './execution/debug-format.ts';
import type { TerminationState } from './execution/library-runtime-context.ts';
import { createScopeRuntime } from './execution/scope-runtime.ts';
import { createVmDispatchRuntime } from './execution/vm-dispatch.ts';
import { createRuntimeSessionApi } from './execution/session-api.ts';
import { createParameterBoundsRuntime } from './execution/parameter-bounds.ts';
import { createMainArgumentsRuntime } from './execution/main-arguments.ts';
import { createResultRuntime } from './execution/result-runtime.ts';
import { createRuntimeState } from './execution/runtime-state.ts';
import { createProgramStartup } from './execution/program-startup.ts';
import { createRuntimePrimitives } from './execution/runtime-primitives.ts';
import type { RuntimePrimitivesLiveState } from './execution/runtime-primitives.ts';

const plain = (value: CValue): Evaluation => ({ value, accesses: new Map(), pendingWrites: new Set() });
const integer = (value: bigint | number | boolean, type: CValue['type'] = 'int'): CValue => ({
  type,
  value: typeof value === 'bigint' ? value : BigInt(typeof value === 'boolean' ? (value ? 1 : 0) : value),
});
const hasPersistentDuration = (binding: Binding): boolean =>
  binding.storageDuration === 'static' || binding.storageDuration === 'thread-local';

export function execute(program: PreparedProgram, options?: ExecuteOptions, runtimeServices?: ExecutionRuntimeServices): ExecuteResult {
  const session = createRuntimeSession(program, options, false, undefined, runtimeServices) as ExecutionSession;
  const result = session.resume();
  // Batch stdin is closed from the start, so this path cannot suspend.
  if (result.kind === 'input-needed') {
    return {
      kind: 'runtime-error',
      diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'Batch execution requested interactive input.', file: program.entry, line: 1, column: 1 }],
      metrics: result.metrics,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return result;
}

/** Create a live VM session whose stdin remains open until endStdin(). */
export function createExecutionSession(
  program: PreparedProgram,
  options?: ExecuteOptions,
  runtimeServices?: ExecutionRuntimeServices,
): ExecutionSession {
  return createRuntimeSession(program, options, true, undefined, runtimeServices) as ExecutionSession;
}

/** Create a live VM session that reports object and scope lifecycle events. */
export function createDebugSession(
  program: PreparedProgram,
  options?: ExecuteOptions,
  debugOptions?: DebugSessionOptions,
  runtimeServices?: ExecutionRuntimeServices,
): DebugExecutionSession {
  return createRuntimeSession(program, options, true, debugOptions === undefined ? {} : debugOptions, runtimeServices) as DebugExecutionSession;
}

function createRuntimeSession(
  program: PreparedProgram,
  options: ExecuteOptions | undefined,
  interactiveStdin: boolean,
  debugOptions?: DebugSessionOptions,
  runtimeServices?: ExecutionRuntimeServices,
): RuntimeSession {
  const started = now();
  const metrics = freshMetrics();
  const location = { file: program && typeof program.entry === 'string' ? program.entry : 'main.c', line: 1, column: 1 };
  let io: VirtualIO | undefined;
  let runtimeLocation: Location = location;
  let awaitingInput = false;
  let stdinEnded = !interactiveStdin;
  let terminalResult: ExecuteResult | DebugLimitResult | undefined;
  let runRuntime: (() => ExecuteProgress | DebugProgress) | undefined;
  let pendingInputError: unknown;
  let debugEvents: DebugEventCollector | undefined;
  let inspectDebugScalars: (() => readonly DebugScalarSnapshot[]) | undefined;
  let inspectDebugPointers: (() => readonly DebugPointerSnapshot[]) | undefined;
  let inspectDebugStaticObjects: ((options?: DebugStaticObjectInspectionOptions) => readonly DebugStaticObjectSnapshot[]) | undefined;
  let inspectDebugArrays: (() => DebugArrayInspection) | undefined;
  let inspectDebugAggregates: (() => DebugAggregateInspection) | undefined;
  let inspectDebugHeapObjects: (() => readonly DebugHeapObjectSnapshot[]) | undefined;
  let debugLocation: Location | null = null;
  let debugPause: DebugPausedResult | undefined;
  let debugEntryReady = false;
  let debugStartPhase = debugOptions !== undefined;
  let debugStepActive = false;
  let debugStepStartLocation: Location | undefined;
  let debugStepExecuted = false;
  let debugInputSuspended = false;
  let debugVisitedInstructions: Map<Frame, Set<number>> | undefined = debugOptions === undefined ? undefined : new Map();
  const { output, exposedDebugLocation, resultForError } = createResultRuntime({
    debugOptions,
    metrics,
    get io() { return io; },
    get runtimeLocation() { return runtimeLocation; },
    get debugLocation() { return debugLocation; },
  });
  const session = createRuntimeSessionApi({
    interactiveStdin,
    debugOptions,
    metrics,
    get terminalResult() { return terminalResult; },
    set terminalResult(value) { terminalResult = value; },
    get runRuntime() { return runRuntime; },
    get awaitingInput() { return awaitingInput; },
    set awaitingInput(value) { awaitingInput = value; },
    get pendingInputError() { return pendingInputError; },
    set pendingInputError(value) { pendingInputError = value; },
    get stdinEnded() { return stdinEnded; },
    set stdinEnded(value) { stdinEnded = value; },
    get debugLocation() { return debugLocation; },
    set debugLocation(value) { debugLocation = value; },
    get debugPause() { return debugPause; },
    set debugPause(value) { debugPause = value; },
    get debugInputSuspended() { return debugInputSuspended; },
    set debugInputSuspended(value) { debugInputSuspended = value; },
    get debugStepStartLocation() { return debugStepStartLocation; },
    set debugStepStartLocation(value) { debugStepStartLocation = value; },
    get debugStepExecuted() { return debugStepExecuted; },
    set debugStepExecuted(value) { debugStepExecuted = value; },
    get debugStepActive() { return debugStepActive; },
    set debugStepActive(value) { debugStepActive = value; },
    get debugVisitedInstructions() { return debugVisitedInstructions; },
    set debugVisitedInstructions(value) { debugVisitedInstructions = value; },
    get io() { return io; },
    get runtimeLocation() { return runtimeLocation; },
    get debugEvents() { return debugEvents; },
    get inspectDebugScalars() { return inspectDebugScalars; },
    get inspectDebugPointers() { return inspectDebugPointers; },
    get inspectDebugStaticObjects() { return inspectDebugStaticObjects; },
    get inspectDebugArrays() { return inspectDebugArrays; },
    get inspectDebugAggregates() { return inspectDebugAggregates; },
    get inspectDebugHeapObjects() { return inspectDebugHeapObjects; },
    now,
    output,
    exposedDebugLocation,
    resultForError,
  });

  try {
    const runtimeState = createRuntimeState({
      program,
      options,
      interactiveStdin,
      debugOptions,
      metrics,
      location,
      get runtimeLocation() { return runtimeLocation; },
      hasPersistentDuration,
    });
    const {
      ir, limits, functions, memory,
      debugObjects, activeDebugFrames,
      allocateDebugObject, publishAutomaticBinding, commitDebugObjectDelete,
      work, operands, globalReferences, initializedStaticBindings, preparedStaticBindings,
      vaCursors, restrictBaseByPointerObject, restrictPointerObjectByBase,
      pointerValueBases, unknownPointerValueBases, integerValueBases, unknownIntegerValueBases,
      activeRestrictBases, restrictBaseParents, restrictObservations,
    } = runtimeState;
    io = runtimeState.io;
    debugEvents = runtimeState.debugEvents;
    inspectDebugScalars = runtimeState.inspectDebugScalars;
    inspectDebugPointers = runtimeState.inspectDebugPointers;
    inspectDebugStaticObjects = runtimeState.inspectDebugStaticObjects;
    inspectDebugArrays = runtimeState.inspectDebugArrays;
    inspectDebugAggregates = runtimeState.inspectDebugAggregates;
    inspectDebugHeapObjects = runtimeState.inspectDebugHeapObjects;
    let nextDebugFrameId = 1;
    let nextDebugScopeId = 1;
    let nextRestrictBaseId = 1;
    let termination: TerminationState | undefined;
    let errnoPointer: CValue | undefined;
    let scopeDepth = 0;
    let callDepth = 0;
    const liveRuntimeState: RuntimePrimitivesLiveState = {
      get io() { return io; },
      set io(value) { io = value; },
      get runtimeLocation() { return runtimeLocation; },
      set runtimeLocation(value) { runtimeLocation = value; },
      get debugEvents() { return debugEvents; },
      get errnoPointer() { return errnoPointer; },
      set errnoPointer(value) { errnoPointer = value; },
      get awaitingInput() { return awaitingInput; },
      set awaitingInput(value) { awaitingInput = value; },
      get debugPause() { return debugPause; },
      set debugPause(value) { debugPause = value; },
      get termination() { return termination; },
      set termination(value) { termination = value; },
      get nextRestrictBaseId() { return nextRestrictBaseId; },
      set nextRestrictBaseId(value) { nextRestrictBaseId = value; },
      get scopeDepth() { return scopeDepth; },
    };
    const runtimePrimitives = createRuntimePrimitives({
      state: runtimeState,
      metrics,
      runtimeServices,
      live: liveRuntimeState,
      plain,
      integer,
      invoke: (...args) => invoke(...args),
    });
    const {
      instruction, localCell, chargeWork, valueForType,
      activePointerBases, activeUnknownPointerBases,
      setPointerBasesForObject, setIntegerPointerBasesForObject,
      truthValue, registerRestrictPointer,
      materialize, evaluateFullExpression, initializeObject,
      resolveVariableType, evaluateVariableBounds, endVaCursor,
      invokeBuiltin, isBuiltinContinuation, defaultArgumentPromotion, startTermination,
      continueLibraryGenerator, defaultReturn,
    } = runtimePrimitives;

    const { enter, leave, jump } = createScopeRuntime({
      ir,
      memory,
      limits,
      activeRestrictBases,
      restrictBaseByPointerObject,
      restrictPointerObjectByBase,
      restrictBaseParents,
      restrictObservations,
      preparedStaticBindings,
      pointerValueBases,
      unknownPointerValueBases,
      integerValueBases,
      unknownIntegerValueBases,
      debugObjects,
      get debugEvents() { return debugEvents; },
      get runtimeLocation() { return runtimeLocation; },
      get scopeDepth() { return scopeDepth; },
      set scopeDepth(value) { scopeDepth = value; },
      get nextDebugScopeId() { return nextDebugScopeId; },
      set nextDebugScopeId(value) { nextDebugScopeId = value; },
      hasPersistentDuration,
      valueForType,
      setPointerBasesForObject,
      setIntegerPointerBasesForObject,
      localCell,
      registerRestrictPointer,
      allocateDebugObject,
      publishAutomaticBinding,
      commitDebugObjectDelete,
    });
    const sameDebugLine = (left: Location | undefined, right: Location): boolean =>
      !!left && left.file === right.file && left.line === right.line;
    const { evaluateParameterBounds } = createParameterBoundsRuntime({
      memory,
      get debugEvents() { return debugEvents; },
      localCell,
      evaluateVariableBounds,
      resolveVariableType,
      hasVariableLengthBound,
      isPointer,
      publishAutomaticBinding,
    });
    const { invoke } = createVmDispatchRuntime({
      ir,
      memory,
      limits,
      metrics,
      debugOptions,
      work,
      operands,
      vaCursors,
      initializedStaticBindings,
      activeDebugFrames,
      get debugEvents() { return debugEvents; },
      get runtimeLocation() { return runtimeLocation; },
      get callDepth() { return callDepth; },
      set callDepth(value) { callDepth = value; },
      get nextDebugFrameId() { return nextDebugFrameId; },
      set nextDebugFrameId(value) { nextDebugFrameId = value; },
      get debugStartPhase() { return debugStartPhase; },
      set debugStartPhase(value) { debugStartPhase = value; },
      get debugEntryReady() { return debugEntryReady; },
      set debugEntryReady(value) { debugEntryReady = value; },
      get debugStepActive() { return debugStepActive; },
      set debugStepActive(value) { debugStepActive = value; },
      get debugStepStartLocation() { return debugStepStartLocation; },
      set debugStepStartLocation(value) { debugStepStartLocation = value; },
      get debugStepExecuted() { return debugStepExecuted; },
      set debugStepExecuted(value) { debugStepExecuted = value; },
      get debugVisitedInstructions() { return debugVisitedInstructions; },
      set debugVisitedInstructions(value) { debugVisitedInstructions = value; },
      get debugLocation() { return debugLocation; },
      set debugLocation(value) { debugLocation = value; },
      get debugPause() { return debugPause; },
      set debugPause(value) { debugPause = value; },
      output,
      sameDebugLine,
      instruction,
      enter,
      evaluateParameterBounds,
      leave,
      evaluateVariableBounds,
      resolveVariableType,
      initializeObject,
      registerRestrictPointer,
      jump,
      evaluateFullExpression,
      materialize,
      valueForType,
      activePointerBases,
      activeUnknownPointerBases,
      truthValue,
      allocateDebugObject,
      publishAutomaticBinding,
      hasPersistentDuration,
      invokeBuiltin,
      isBuiltinContinuation,
      continueLibraryGenerator,
      defaultArgumentPromotion,
      defaultReturn,
      endVaCursor,
      plain,
      integer,
    });
    const { mainArguments } = createMainArgumentsRuntime({
      memory,
      get io() { return io; },
      chargeWork,
      integer,
      valueForType,
    });

    const programStartup = createProgramStartup({
      ir,
      functions,
      location,
      metrics,
      debugOptions,
      get debugEvents() { return debugEvents; },
      memory,
      globalReferences,
      work,
      operands,
      get runtimeLocation() { return runtimeLocation; },
      get awaitingInput() { return awaitingInput; },
      get debugPause() { return debugPause; },
      get termination() { return termination; },
      get debugEntryReady() { return debugEntryReady; },
      get debugLocation() { return debugLocation; },
      set debugLocation(value) { debugLocation = value; },
      get debugStepActive() { return debugStepActive; },
      set debugStepActive(value) { debugStepActive = value; },
      allocateDebugObject,
      debugTypeSummary,
      initializeObject,
      mainArguments,
      invoke,
      valueForType,
      materialize,
      startTermination,
      output,
    });
    runRuntime = programStartup.runRuntime;
    programStartup.prepareDebugEntry();
    // Include synchronous VM setup in execution time, then count only actual
    // resume work; wall time spent waiting for input is excluded.
    metrics.executeMs += now() - started;
    return session;
  } catch (error) {
    terminalResult = resultForError(error);
    if (debugOptions !== undefined) debugLocation = null;
    metrics.executeMs += now() - started;
    return session;
  }
}
