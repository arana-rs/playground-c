import { enforceLimit, failure } from '../internal.ts';
import type { CValue, Location, ObjectReference } from '../internal.ts';
import { truth } from '../numeric.ts';
import type { DebugPausedResult, EngineMetrics, ExecutionRuntimeServices } from '../types.ts';
import type { VirtualIO } from '../virtual-io.ts';
import type { TerminationState } from './library-runtime-context.ts';
import type { DebugEventCollector } from './debug-events.ts';
import { debugTypeSummary } from './debug-format.ts';
import type { ExpressionRuntimeContext } from './expression-runtime-context.ts';
import type { createRuntimeState } from './runtime-state.ts';
import type { Cell, Frame } from './runtime-types.ts';
import { createIOMemoryBridge } from './io-memory-bridge.ts';
import { createStdlibRuntimeContext } from './stdlib-runtime-context.ts';
import { createPointerRuntime } from './pointer-runtime.ts';
import { createRestrictRuntime } from './restrict-runtime.ts';
import { createEffectsRuntime } from './effects-runtime.ts';
import { createInitializationRuntime } from './initialization-runtime.ts';
import { createVariableTypeRuntime } from './variable-type-runtime.ts';
import { createLibraryRuntime, isBuiltinContinuation } from './library-runtime.ts';
import { createExpressionRuntime } from './expression-runtime.ts';
import type { ExpressionRuntimeFactoryContext } from './expression-runtime.ts';

type RuntimeState = ReturnType<typeof createRuntimeState>;

export interface RuntimePrimitivesLiveState {
  get io(): VirtualIO | undefined;
  set io(value: VirtualIO | undefined);
  get runtimeLocation(): Location;
  set runtimeLocation(value: Location);
  get debugEvents(): DebugEventCollector | undefined;
  get errnoPointer(): CValue | undefined;
  set errnoPointer(value: CValue | undefined);
  get awaitingInput(): boolean;
  set awaitingInput(value: boolean);
  get debugPause(): DebugPausedResult | undefined;
  set debugPause(value: DebugPausedResult | undefined);
  get termination(): TerminationState | undefined;
  set termination(value: TerminationState | undefined);
  get nextRestrictBaseId(): number;
  set nextRestrictBaseId(value: number);
  get scopeDepth(): number;
}

export interface RuntimePrimitivesContext {
  readonly state: RuntimeState;
  readonly metrics: EngineMetrics;
  readonly runtimeServices: ExecutionRuntimeServices | undefined;
  readonly live: RuntimePrimitivesLiveState;
  readonly plain: ExpressionRuntimeContext['plain'];
  readonly integer: ExpressionRuntimeContext['integer'];
  readonly invoke: ExpressionRuntimeContext['invoke'];
}

/** Connect memory, provenance, evaluation, and library runtimes over one live session state. */
export function createRuntimePrimitives(context: RuntimePrimitivesContext) {
  const { state, live, metrics, runtimeServices, plain, integer } = context;
  const {
    ir, limits, functions, functionIndices, functionSymbolIndices, memory,
    work, operands, globalReferences, initializedStaticExpressions, vaCursors,
    normalTerminationHandlers, quickTerminationHandlers, stdlibState,
    restrictBaseByPointerObject, restrictPointerObjectByBase, pointerOriginsByObject,
    unknownPointerOriginsByObject, integerPointerOriginsByObject, unknownIntegerPointerOriginsByObject,
    integerPointerOriginReferences, pointerValueBases, unknownPointerValueBases,
    integerValueBases, unknownIntegerValueBases, activeRestrictBases, restrictBaseParents, restrictObservations,
  } = state;

  const ioMemoryBridge = createIOMemoryBridge({
    memory,
    metrics,
    pointerValueBases,
    unknownPointerValueBases,
    integerValueBases,
    unknownIntegerValueBases,
    get runtimeLocation() { return live.runtimeLocation; },
    get io() { return live.io; },
    get limits() { return limits; },
    failure,
    enforceLimit,
    observeRestrictAddress: (pointer, bases, unknownBases, byteCount, write, at) =>
      observeRestrictAddress(pointer, bases, unknownBases, byteCount, write, at),
    observeRestrictAccess: (reference, addressBases, unknownAddressBases, write, at) =>
      observeRestrictAccess(reference, addressBases, unknownAddressBases, write, at),
    clearIntegerPointerOriginsInRange: (allocationId, byteOffset, byteCount) =>
      clearIntegerPointerOriginsInRange(allocationId, byteOffset, byteCount),
    copyIntegerPointerOrigins: (allocationId, byteOffset, byteCount) =>
      copyIntegerPointerOrigins(allocationId, byteOffset, byteCount),
    restoreIntegerPointerOrigins: (allocationId, byteOffset, byteCount, copied) =>
      restoreIntegerPointerOrigins(allocationId, byteOffset, byteCount, copied),
    valueForType: (value, type, at) => valueForType(value, type, at),
    setPointerBasesForObject: (reference, bases, unknownBases) =>
      setPointerBasesForObject(reference, bases, unknownBases),
    setIntegerPointerBasesForObject: (reference, bases, unknownBases) =>
      setIntegerPointerBasesForObject(reference, bases, unknownBases),
  });
  const {
    chargeWork,
  } = ioMemoryBridge;

  const libraryContext = createStdlibRuntimeContext({
    ir,
    memory,
    metrics,
    stdlibState,
    runtimeServices,
    get runtimeLocation() { return live.runtimeLocation; },
    get io() { return live.io; },
    get errnoPointer() { return live.errnoPointer; },
    set errnoPointer(value) { live.errnoPointer = value; },
    allocateDebugHeap: state.allocateDebugHeap,
    allocateDebugObject: state.allocateDebugObject,
    ioMemoryBridge,
    cursorFromHandle: (...args) => cursorFromHandle(...args),
    observeRestrictAccess: (...args) => observeRestrictAccess(...args),
    getErrnoReference: state.getErrnoReference,
    integer,
    valueForType: (...args) => valueForType(...args),
    rememberPointerBases: (...args) => rememberPointerBases(...args),
    pointerValueBases,
    unknownPointerValueBases,
    copyIntegerPointerOrigins: (...args) => copyIntegerPointerOrigins(...args),
    restoreIntegerPointerOrigins: (...args) => restoreIntegerPointerOrigins(...args),
  });

  const instruction = (at: Location) => {
    live.runtimeLocation = at;
    live.io!.setLocation(at);
    metrics.instructionCount++;
    enforceLimit('maxInstructions', metrics.instructionCount, limits.maxInstructions, at);
  };
  const localCell = (frame: Frame, binding: number, at: Location): Cell => {
    const result = frame.cells.get(binding);
    if (!result) failure('INACTIVE_OBJECT', 'The variable does not belong to an active scope.', at);
    return result;
  };
  const globalReference = (binding: number, at: Location): ObjectReference => {
    const result = globalReferences.get(binding);
    if (!result) failure('UNKNOWN_OBJECT', 'Requested global object does not exist.', at);
    return result;
  };
  const {
    valueForType, activePointerBases, activeUnknownPointerBases,
    unionPointerBases, unionUnknownPointerBases, rememberPointerBases,
    rememberIntegerPointerBases, pointerBasesForObject,
    unknownPointerBasesForObject, setPointerBasesForObject, integerPointerBasesForObject,
    unknownIntegerPointerBasesForObject, setIntegerPointerBasesForObject,
    clearIntegerPointerOriginsInRange, copyIntegerPointerOrigins, restoreIntegerPointerOrigins,
    integerPointerOrigins, hasIntegerPointerOrigins, propagateIntegerPointerOperation,
  } = createPointerRuntime({
    ir,
    memory,
    get runtimeLocation() { return live.runtimeLocation; },
    activeRestrictBases,
    restrictBaseByPointerObject,
    restrictBaseParents,
    pointerOriginsByObject,
    unknownPointerOriginsByObject,
    integerPointerOriginsByObject,
    unknownIntegerPointerOriginsByObject,
    integerPointerOriginReferences,
    pointerValueBases,
    unknownPointerValueBases,
    integerValueBases,
    unknownIntegerValueBases,
    integer,
  });
  const truthValue = (value: CValue): boolean => truth(value, live.runtimeLocation);
  const {
    registerRestrictPointer,
    observeRestrictAddress, observeRestrictAccess,
  } = createRestrictRuntime({
    memory,
    activeRestrictBases,
    restrictBaseByPointerObject,
    restrictPointerObjectByBase,
    restrictBaseParents,
    restrictObservations,
    get nextRestrictBaseId() { return live.nextRestrictBaseId; },
    set nextRestrictBaseId(value) { live.nextRestrictBaseId = value; },
    activePointerBases,
    activeUnknownPointerBases,
  });
  const {
    mergeEffects, referenceEvaluation, markRead, markWrite,
    materialize, evaluateFullExpression,
  } = createEffectsRuntime({
    memory,
    pointerValueBases,
    unknownPointerValueBases,
    work,
    get runtimeLocation() { return live.runtimeLocation; },
    activePointerBases,
    activeUnknownPointerBases,
    unionPointerBases,
    unionUnknownPointerBases,
    rememberPointerBases,
    rememberIntegerPointerBases,
    pointerBasesForObject,
    unknownPointerBasesForObject,
    integerPointerBasesForObject,
    unknownIntegerPointerBasesForObject,
    observeRestrictAccess,
    clearIntegerPointerOriginsInRange,
    evaluate: (...args) => evaluate(...args),
  });
  const {
    aggregateDefinition, initializeObject, stringReference,
  } = createInitializationRuntime({
    ir,
    memory,
    operands,
    work,
    integerValueBases,
    unknownIntegerValueBases,
    integer,
    valueForType,
    evaluateFullExpression,
    materialize,
    setPointerBasesForObject,
    setIntegerPointerBasesForObject,
    get debugEvents() { return live.debugEvents; },
    allocateDebugObject: state.allocateDebugObject,
  });
  const { resolveVariableType, evaluateVariableBounds } = createVariableTypeRuntime({
    ir,
    memory,
    work,
    operands,
    get runtimeLocation() { return live.runtimeLocation; },
    evaluateFullExpression,
    materialize,
  });

  let evaluateRuntime!: ExpressionRuntimeContext['evaluate'];
  const evaluate: ExpressionRuntimeContext['evaluate'] = (...args) => evaluateRuntime(...args);
  const {
    cursorFromHandle, endVaCursor, invokeBuiltin,
    defaultArgumentPromotion,
    startTermination, continueLibraryGenerator, defaultReturn,
  } = createLibraryRuntime({
    functions,
    memory,
    vaCursors,
    work,
    operands,
    normalTerminationHandlers,
    quickTerminationHandlers,
    pointerValueBases,
    unknownPointerValueBases,
    activeRestrictBases,
    libraryContext,
    get runtimeLocation() { return live.runtimeLocation; },
    set runtimeLocation(value) { live.runtimeLocation = value; },
    get io() { return live.io; },
    set io(value) { live.io = value; },
    get debugEvents() { return live.debugEvents; },
    debugObjects: state.debugObjects,
    get awaitingInput() { return live.awaitingInput; },
    set awaitingInput(value) { live.awaitingInput = value; },
    get debugPause() { return live.debugPause; },
    set debugPause(value) { live.debugPause = value; },
    get termination() { return live.termination; },
    set termination(value) { live.termination = value; },
    markerId: state.markerId,
    valueForType,
    activePointerBases,
    activeUnknownPointerBases,
    integerPointerOrigins,
    hasIntegerPointerOrigins,
    rememberIntegerPointerBases,
    allocateDebugHeap: state.allocateDebugHeap,
    reallocateDebugHeap: state.reallocateDebugHeap,
    commitDebugObjectDelete: state.commitDebugObjectDelete,
    plain,
    integer,
    invoke: (...args) => context.invoke(...args),
  });
  const expressionRuntimeContext: ExpressionRuntimeFactoryContext = {
    ir,
    functions,
    functionIndices,
    functionSymbolIndices,
    memory,
    get debugEvents() { return live.debugEvents; },
    work,
    operands,
    vaCursors,
    initializedStaticExpressions,
    pointerValueBases,
    unknownPointerValueBases,
    integerValueBases,
    unknownIntegerValueBases,
    localCell,
    globalReference,
    plain,
    integer,
    valueForType,
    truthValue,
    activePointerBases,
    activeUnknownPointerBases,
    unionPointerBases,
    unionUnknownPointerBases,
    rememberPointerBases,
    rememberIntegerPointerBases,
    propagateIntegerPointerOperation,
    pointerBasesForObject,
    unknownPointerBasesForObject,
    integerPointerBasesForObject,
    unknownIntegerPointerBasesForObject,
    setPointerBasesForObject,
    setIntegerPointerBasesForObject,
    integerPointerOrigins,
    hasIntegerPointerOrigins,
    mergeEffects,
    referenceEvaluation,
    markRead,
    markWrite,
    materialize,
    evaluateFullExpression,
    resolveVariableType,
    evaluateVariableBounds,
    initializeObject,
    aggregateDefinition,
    stringReference,
    markerId: state.markerId,
    invokeBuiltin,
    isBuiltinContinuation,
    continueLibraryGenerator,
    defaultArgumentPromotion,
    invoke: (...args) => context.invoke(...args),
    allocateDebugObject: state.allocateDebugObject,
    debugTypeSummary,
    limits,
    get scopeDepth() { return live.scopeDepth; },
    instruction,
  };
  const expressionRuntime = createExpressionRuntime(expressionRuntimeContext);
  evaluateRuntime = expressionRuntime.evaluate;

  return {
    instruction,
    localCell,
    globalReference,
    chargeWork,
    valueForType,
    activePointerBases,
    activeUnknownPointerBases,
    unionPointerBases,
    unionUnknownPointerBases,
    rememberPointerBases,
    rememberIntegerPointerBases,
    pointerBasesForObject,
    unknownPointerBasesForObject,
    setPointerBasesForObject,
    integerPointerBasesForObject,
    unknownIntegerPointerBasesForObject,
    setIntegerPointerBasesForObject,
    clearIntegerPointerOriginsInRange,
    copyIntegerPointerOrigins,
    restoreIntegerPointerOrigins,
    integerPointerOrigins,
    hasIntegerPointerOrigins,
    propagateIntegerPointerOperation,
    truthValue,
    registerRestrictPointer,
    observeRestrictAddress,
    observeRestrictAccess,
    mergeEffects,
    referenceEvaluation,
    markRead,
    markWrite,
    materialize,
    evaluateFullExpression,
    aggregateDefinition,
    initializeObject,
    stringReference,
    resolveVariableType,
    evaluateVariableBounds,
    evaluate,
    cursorFromHandle,
    endVaCursor,
    invokeBuiltin,
    isBuiltinContinuation,
    defaultArgumentPromotion,
    startTermination,
    continueLibraryGenerator,
    defaultReturn,
  };
}
