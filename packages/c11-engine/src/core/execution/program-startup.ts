import { failure } from '../internal.ts';
import type { CType, Location, ObjectReference, ProgramIR } from '../internal.ts';
import type { CompiledFunction } from '../bytecode.ts';
import { qualifiersOf } from '../type-system.ts';
import type {
  DebugPausedResult, DebugSessionOptions, EngineMetrics, ExecuteProgress, DebugProgress,
} from '../types.ts';
import type { VirtualMemory } from '../memory.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { DebugObjectMetadata, Evaluation, Frame } from './runtime-types.ts';
import type { TerminationState } from './library-runtime-context.ts';

export interface ProgramStartupContext {
  readonly ir: ProgramIR;
  readonly functions: readonly CompiledFunction[];
  readonly location: Location;
  readonly metrics: EngineMetrics;
  readonly debugOptions: DebugSessionOptions | undefined;
  get debugEvents(): DebugEventCollector | undefined;
  readonly memory: VirtualMemory;
  readonly globalReferences: Map<number, ObjectReference>;
  readonly work: Array<() => void>;
  readonly operands: Evaluation[];
  get runtimeLocation(): Location;
  get awaitingInput(): boolean;
  get debugPause(): DebugPausedResult | undefined;
  get termination(): TerminationState | undefined;
  get debugEntryReady(): boolean;
  get debugLocation(): Location | null;
  set debugLocation(value: Location | null);
  get debugStepActive(): boolean;
  set debugStepActive(value: boolean);
  readonly allocateDebugObject: (allocate: () => ObjectReference, metadata: DebugObjectMetadata) => ObjectReference;
  readonly debugTypeSummary: (type: CType, aggregates: ProgramIR['aggregates']) => string;
  readonly initializeObject: (reference: ObjectReference, type: CType, initializer: import('../internal.ts').Initializer, frame: Frame) => void;
  readonly mainArguments: (compiled: CompiledFunction) => import('../internal.ts').CValue[];
  readonly invoke: (compiled: CompiledFunction, args: import('../internal.ts').CValue[], at: Location) => void;
  readonly valueForType: (value: import('../internal.ts').CValue, type: CType, at: Location) => import('../internal.ts').CValue;
  readonly materialize: (evaluation: Evaluation, at: Location) => import('../internal.ts').CValue;
  readonly startTermination: (kind: 'normal', status: bigint, at: Location) => void;
  readonly output: () => { stdout: Uint8Array; stderr: Uint8Array };
}

export interface ProgramStartup {
  readonly runRuntime: () => ExecuteProgress | DebugProgress;
  readonly prepareDebugEntry: () => void;
}

/** Allocate static objects, schedule entry work, and expose the session driver. */
export function createProgramStartup(context: ProgramStartupContext): ProgramStartup {
  const initializeGlobal = (globalIndex: number, frame: Frame): void => {
    const global = context.ir.globals[globalIndex];
    if (!global.declarationOnly && global.initializer) {
      const reference = context.globalReferences.get(global.id);
      if (!reference) failure('UNKNOWN_OBJECT', 'Global object was not found during initialization.', global.location);
      context.initializeObject(reference, global.type, global.initializer, frame);
    }
  };

  for (const global of context.ir.globals) {
    if (global.declarationOnly) continue;
    const duration = global.threadLocal ? 'thread-local' : 'static';
    const allocationOptions = {
      isConst: global.isConst === true || qualifiersOf(global.type).const || global.qualifiers?.const === true,
      ...(global.alignment === undefined ? {} : { alignment: global.alignment }),
    };
    const reference = context.debugEvents
      ? context.memory.findStaticObject(global) ?? context.allocateDebugObject(
        () => context.memory.staticObject(global, global.type, global.location, duration, allocationOptions),
        {
          duration, origin: 'variable', typeSummary: context.debugTypeSummary(global.type, context.ir.aggregates),
          location: global.location, frameId: null, scopeId: null, name: global.name,
          readOnly: allocationOptions.isConst,
        },
      )
      : context.memory.staticObject(global, global.type, global.location, duration, allocationOptions);
    context.memory.zeroInitialize(reference, global.location);
    context.globalReferences.set(global.id, reference);
  }

  const initializationFrame: Frame = {
    compiled: context.functions[context.ir.mainIndex], frameId: null, args: [], variadicArgs: [], vaCursorIds: new Set(), temporaryObjects: [],
    pc: 0, cells: new Map(), vlaLengths: new Map(), scopes: [], returned: false,
  };
  const entryFunction = context.functions[context.ir.mainIndex];
  if (!entryFunction?.fn.body) failure('UNDEFINED_ENTRY', 'main has no executable definition.', entryFunction?.fn.location ?? context.location);
  const entryArgs = context.mainArguments(entryFunction);
  context.work.push(() => context.invoke(entryFunction, entryArgs, entryFunction.fn.location));
  for (let index = context.ir.globals.length - 1; index >= 0; index--) {
    const globalIndex = index;
    context.work.push(() => initializeGlobal(globalIndex, initializationFrame));
  }

  const runRuntime = (): ExecuteProgress | DebugProgress => {
    while (context.work.length && !context.awaitingInput && !context.debugPause) context.work.pop()!();
    const paused = context.debugPause;
    if (paused) {
      context.debugStepActive = false;
      return paused;
    }
    if (context.awaitingInput) return { kind: 'input-needed', metrics: context.metrics, ...context.output() };
    if (!context.termination) {
      const result = context.operands.pop();
      if (!result) failure('ENGINE_STACK_ERROR', 'main did not produce a termination status.', entryFunction.fn.location);
      const status = context.valueForType(context.materialize(result, entryFunction.fn.location), 'int', entryFunction.fn.location).value;
      if (typeof status !== 'bigint') failure('ENGINE_INTERNAL_ERROR', 'main status is not an integer.', entryFunction.fn.location);
      context.startTermination('normal', status, entryFunction.fn.location);
      while (context.work.length && !context.awaitingInput && !context.debugPause) context.work.pop()!();
      const pausedAfterTermination = context.debugPause;
      if (pausedAfterTermination) {
        context.debugStepActive = false;
        return pausedAfterTermination;
      }
      if (context.awaitingInput) return { kind: 'input-needed', metrics: context.metrics, ...context.output() };
    }
    const termination = context.termination;
    if (!termination?.completed) failure('ENGINE_INTERNAL_ERROR', 'Termination did not complete its handler sequence.', context.runtimeLocation);
    const rawExitStatus = Number(BigInt.asIntN(32, termination.status));
    return {
      kind: 'terminated',
      exitCode: Number(BigInt.asUintN(8, termination.status)),
      rawExitStatus,
      mainReturn: rawExitStatus,
      metrics: context.metrics,
      ...context.output(),
    };
  };

  const prepareDebugEntry = (): void => {
    if (context.debugOptions !== undefined) {
      // Run global initialization and enter main's root scope once, stopping before its first source instruction.
      while (context.work.length && !context.debugEntryReady) context.work.pop()!();
      context.debugLocation = context.debugEntryReady ? context.debugLocation : null;
    }
  };
  return { runRuntime, prepareDebugEntry };
}
