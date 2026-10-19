import { DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS, DEFAULT_EXECUTE_LIMITS } from '../types.ts';
import type { DebugSessionOptions, EngineMetrics, ExecuteOptions, PreparedProgram } from '../types.ts';
import { enforceLimit, failure, normalizedLimits, programs } from '../internal.ts';
import type { Binding, CValue, Location, ObjectPointerValue, ObjectReference } from '../internal.ts';
import { compile } from '../bytecode.ts';
import { VirtualMemory } from '../memory.ts';
import { VirtualIO } from '../virtual-io.ts';
import type { StdlibSessionState } from '../stdlib-time-context.ts';
import { DebugEventCollector } from './debug-events.ts';
import type { DebugObjectRecord, Evaluation, Frame, RestrictObservation, VaCursor } from './runtime-types.ts';
import { DEFAULT_DEBUG_EVENT_BUDGET, MAX_HEAP_ADDRESS_SEED, heapAddressRandomForSeed } from './debug-format.ts';
import { createAggregateInspector } from './debug-inspection-aggregates.ts';
import { createArrayInspector } from './debug-inspection-arrays.ts';
import { snapshotPointerTarget } from './debug-inspection-context.ts';
import { createHeapInspector } from './debug-inspection-heap.ts';
import { createScalarInspectors } from './debug-inspection-scalars.ts';
import type { DebugInspectionContext } from './debug-inspection-context.ts';
import { createDebugObjectRuntime } from './debug-object-runtime.ts';

export interface RuntimeStateContext {
  readonly program: PreparedProgram;
  readonly options: ExecuteOptions | undefined;
  readonly interactiveStdin: boolean;
  readonly debugOptions: DebugSessionOptions | undefined;
  readonly metrics: EngineMetrics;
  readonly location: Location;
  get runtimeLocation(): Location;
  readonly hasPersistentDuration: (binding: Binding) => boolean;
}

/** Build stable per-session execution state before connecting its runtime closures. */
export function createRuntimeState(context: RuntimeStateContext) {
  const candidate = programs.get(context.program);
  if (!candidate) failure('INVALID_PROGRAM', 'The program must come from prepare in this engine instance; copies and external programs are not accepted.', context.location);
  const ir = candidate;
  context.metrics.sourceChars = ir.sourceChars;
  context.metrics.tokenCount = ir.tokenCount;
  const { options, debugOptions } = context;
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
    failure('INVALID_OPTIONS', 'Execution options must be an object.', context.location);
  }
  let debugEvents: DebugEventCollector | undefined;
  if (debugOptions !== undefined) {
    if (!debugOptions || typeof debugOptions !== 'object' || Array.isArray(debugOptions)) {
      failure('INVALID_OPTIONS', 'Debug options must be an object.', context.location);
    }
    for (const key of Object.keys(debugOptions)) {
      if (key !== 'maxEvents' && key !== 'heapAddressSeed' && key !== 'maxObjects' &&
          key !== 'maxElementsPerArray' && key !== 'maxValueChars') {
        failure('INVALID_OPTIONS', `Unknown debug option: ${key}.`, context.location);
      }
    }
    const maxEvents = debugOptions.maxEvents === undefined ? DEFAULT_DEBUG_EVENT_BUDGET : debugOptions.maxEvents;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) {
      failure('INVALID_OPTIONS', 'maxEvents must be a nonnegative safe integer.', context.location);
    }
    if (debugOptions.heapAddressSeed !== undefined &&
        (!Number.isInteger(debugOptions.heapAddressSeed) || debugOptions.heapAddressSeed < 0 || debugOptions.heapAddressSeed > MAX_HEAP_ADDRESS_SEED)) {
      failure('INVALID_OPTIONS', 'heapAddressSeed must be an integer from 0 to 2^32-1.', context.location);
    }
    for (const [key, value] of [
      ['maxObjects', debugOptions.maxObjects],
      ['maxElementsPerArray', debugOptions.maxElementsPerArray],
      ['maxValueChars', debugOptions.maxValueChars],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        failure('INVALID_OPTIONS', `${key} must be a nonnegative safe integer.`, context.location);
      }
    }
    debugEvents = new DebugEventCollector(maxEvents);
  }
  const limits = normalizedLimits(DEFAULT_EXECUTE_LIMITS, options?.limits, context.location);
  const suppliedIO = options?.io;
  if (debugOptions !== undefined && suppliedIO !== undefined &&
      (!suppliedIO || typeof suppliedIO !== 'object' || Array.isArray(suppliedIO))) {
    failure('INVALID_OPTIONS', 'io must be an object.', context.location);
  }
  const io = new VirtualIO({
    entry: ir.entry,
    io: suppliedIO,
    maxBytes: limits.maxIOBytes,
    interactiveStdin: context.interactiveStdin,
    checkLimit: (actual, at) => enforceLimit('maxIOBytes', actual, limits.maxIOBytes, at),
  });
  const functions = ir.functions.map((fn) => compile(fn));
  const functionIndices = new Map<string, number>();
  const functionSymbolIndices = new Map<string, number>();
  ir.functions.forEach((fn, index) => {
    if (!functionIndices.has(fn.name)) functionIndices.set(fn.name, index);
    if (fn.symbolKey) functionSymbolIndices.set(fn.symbolKey, index);
  });
  const memory = new VirtualMemory(
    ir.aggregates,
    limits.maxMemoryBytes,
    context.metrics,
    debugOptions?.heapAddressSeed === undefined ? Math.random : heapAddressRandomForSeed(debugOptions.heapAddressSeed),
    debugOptions !== undefined,
  );
  const debugObjects = debugEvents ? new Map<number, DebugObjectRecord>() : undefined;
  const debugObjectLocations = debugEvents ? new Map<number, Location>() : undefined;
  const activeDebugFrames = debugEvents ? [] as Frame[] : undefined;
  const maxArrayObjects = debugOptions?.maxObjects ?? DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxObjects;
  const maxElementsPerArray = debugOptions?.maxElementsPerArray ?? DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxElementsPerArray;
  const maxValueChars = debugOptions?.maxValueChars ?? DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxValueChars;
  let inspectDebugScalars: (() => readonly import('../types.ts').DebugScalarSnapshot[]) | undefined;
  let inspectDebugPointers: (() => readonly import('../types.ts').DebugPointerSnapshot[]) | undefined;
  let inspectDebugStaticObjects: ((options?: import('../types.ts').DebugStaticObjectInspectionOptions) => readonly import('../types.ts').DebugStaticObjectSnapshot[]) | undefined;
  let inspectDebugArrays: (() => import('../types.ts').DebugArrayInspection) | undefined;
  let inspectDebugAggregates: (() => import('../types.ts').DebugAggregateInspection) | undefined;
  let inspectDebugHeapObjects: (() => readonly import('../types.ts').DebugHeapObjectSnapshot[]) | undefined;
  if (debugEvents && debugObjects && activeDebugFrames) {
    const debugInspectionContext: DebugInspectionContext = {
      ir,
      location: context.location,
      memory,
      debugObjects,
      debugObjectLocations: debugObjectLocations!,
      activeDebugFrames,
      maxArrayObjects,
      maxElementsPerArray,
      maxValueChars,
      hasPersistentDuration: context.hasPersistentDuration,
    };
    const scalarInspectors = createScalarInspectors(debugInspectionContext);
    inspectDebugScalars = scalarInspectors.inspectScalars;
    inspectDebugPointers = scalarInspectors.inspectPointers;
    inspectDebugStaticObjects = scalarInspectors.inspectStaticObjects;
    inspectDebugArrays = createArrayInspector(debugInspectionContext, snapshotPointerTarget);
    inspectDebugAggregates = createAggregateInspector(debugInspectionContext, snapshotPointerTarget);
    inspectDebugHeapObjects = createHeapInspector(debugInspectionContext);
  }
  const {
    allocateDebugObject, publishAutomaticBinding,
    allocateDebugHeap, reallocateDebugHeap, commitDebugObjectDelete,
  } = createDebugObjectRuntime({
    ir,
    memory,
    debugObjects,
    debugObjectLocations,
    get debugEvents() { return debugEvents; },
    hasPersistentDuration: context.hasPersistentDuration,
  });
  const work: (() => void)[] = [];
  const operands: Evaluation[] = [];
  const globalReferences = new Map<number, ObjectReference>();
  const initializedStaticExpressions = new WeakSet<object>();
  const initializedStaticBindings = new WeakSet<Binding>();
  const preparedStaticBindings = new WeakSet<Binding>();
  const vaCursors = new Map<number, VaCursor>();
  const restrictBaseByPointerObject = new Map<number, number>();
  const restrictPointerObjectByBase = new Map<number, number>();
  const pointerOriginsByObject = new Map<number, Set<number>>();
  const unknownPointerOriginsByObject = new Map<number, Set<number>>();
  const integerPointerOriginsByObject = new Map<number, Set<number>>();
  const unknownIntegerPointerOriginsByObject = new Map<number, Set<number>>();
  const integerPointerOriginReferences = new Map<number, ObjectReference>();
  const pointerValueBases = new WeakMap<ObjectPointerValue, Set<number>>();
  const unknownPointerValueBases = new WeakMap<ObjectPointerValue, Set<number>>();
  const integerValueBases = new WeakMap<CValue, Set<number>>();
  const unknownIntegerValueBases = new WeakMap<CValue, Set<number>>();
  const activeRestrictBases = new Map<number, object>();
  // Restrict pointers initialized or assigned from another restricted pointer
  // belong to one provenance chain. Accesses through either member of that
  // chain must not be mistaken for independent aliases in a nested call.
  const restrictBaseParents = new Map<number, Set<number>>();
  const restrictObservations = new Map<number, Map<string, RestrictObservation>>();
  const stdlibState: StdlibSessionState = { randState: 1, textBufferCapacity: 0, environmentBuffers: new Map() };
  const normalTerminationHandlers: CValue[] = [];
  const quickTerminationHandlers: CValue[] = [];
  let errnoReference: ObjectReference | undefined;
  const getErrnoReference = (): ObjectReference => {
    if (!errnoReference) {
      errnoReference = memory.allocate('int', 'static', context.runtimeLocation);
      memory.zeroInitialize(errnoReference, context.runtimeLocation);
    }
    return errnoReference;
  };
  const markerId = (value: CValue): number | undefined => {
    if (typeof value.value !== 'object' || value.value === null || value.value.kind !== 'object-pointer') return undefined;
    return value.value.allocationId;
  };
  return {
    ir, limits, io, debugEvents, functions, functionIndices, functionSymbolIndices, memory,
    debugObjects, debugObjectLocations, activeDebugFrames,
    inspectDebugScalars, inspectDebugPointers, inspectDebugStaticObjects,
    inspectDebugArrays, inspectDebugAggregates, inspectDebugHeapObjects,
    allocateDebugObject, publishAutomaticBinding, allocateDebugHeap, reallocateDebugHeap, commitDebugObjectDelete,
    work, operands, globalReferences, initializedStaticExpressions, initializedStaticBindings, preparedStaticBindings, vaCursors,
    restrictBaseByPointerObject, restrictPointerObjectByBase,
    pointerOriginsByObject, unknownPointerOriginsByObject, integerPointerOriginsByObject,
    unknownIntegerPointerOriginsByObject, integerPointerOriginReferences,
    pointerValueBases, unknownPointerValueBases, integerValueBases, unknownIntegerValueBases,
    activeRestrictBases, restrictBaseParents, restrictObservations,
    stdlibState, normalTerminationHandlers, quickTerminationHandlers, getErrnoReference, markerId,
  };
}
