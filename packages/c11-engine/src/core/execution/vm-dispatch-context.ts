import type { CompiledFunction, Scope } from '../bytecode.ts';
import type {
  ArrayCType, Binding, CType, CValue, Expression, Initializer, Location, Parameter,
  ObjectReference, ProgramIR, VariablyModifiedIdentifier,
} from '../internal.ts';
import type { VirtualMemory } from '../memory.ts';
import type { LibraryBuiltinResult, ResumableLibraryBuiltin } from '../library.ts';
import type {
  DebugPausedResult, DebugSessionOptions, EngineMetrics, ExecuteLimits, ExecutionOutput,
} from '../types.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { DebugObjectMetadata, Evaluation, Frame, RuntimeScope, VaCursor } from './runtime-types.ts';

/** Live VM state and operations required to dispatch compiled instructions and calls. */
export interface VmDispatchRuntimeContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  readonly limits: ExecuteLimits;
  readonly metrics: EngineMetrics;
  readonly debugOptions: DebugSessionOptions | undefined;
  readonly work: Array<() => void>;
  readonly operands: Evaluation[];
  readonly vaCursors: Map<number, VaCursor>;
  readonly initializedStaticBindings: WeakSet<Binding>;
  readonly activeDebugFrames: Frame[] | undefined;
  get debugEvents(): DebugEventCollector | undefined;
  get runtimeLocation(): Location;
  get callDepth(): number;
  set callDepth(value: number);
  get nextDebugFrameId(): number;
  set nextDebugFrameId(value: number);
  get debugStartPhase(): boolean;
  set debugStartPhase(value: boolean);
  get debugEntryReady(): boolean;
  set debugEntryReady(value: boolean);
  get debugStepActive(): boolean;
  set debugStepActive(value: boolean);
  get debugStepStartLocation(): Location | undefined;
  set debugStepStartLocation(value: Location | undefined);
  get debugStepExecuted(): boolean;
  set debugStepExecuted(value: boolean);
  get debugVisitedInstructions(): Map<Frame, Set<number>> | undefined;
  set debugVisitedInstructions(value: Map<Frame, Set<number>> | undefined);
  get debugLocation(): Location | null;
  set debugLocation(value: Location | null);
  get debugPause(): DebugPausedResult | undefined;
  set debugPause(value: DebugPausedResult | undefined);
  readonly output: () => ExecutionOutput;
  readonly sameDebugLine: (left: Location | undefined, right: Location) => boolean;
  readonly instruction: (at: Location) => void;
  readonly enter: (frame: Frame, layout: Scope) => void;
  readonly evaluateParameterBounds: (frame: Frame, parameters: readonly Parameter[]) => void;
  readonly leave: (frame: Frame, eventLocation?: Location) => void;
  readonly evaluateVariableBounds: (
    arrayTypes: readonly ArrayCType[], frame: Frame, at: Location, done: () => void,
  ) => void;
  readonly resolveVariableType: (type: CType, frame: Frame, at: Location) => CType;
  readonly initializeObject: (
    reference: ObjectReference, type: CType, initializer: Initializer, frame: Frame,
  ) => void;
  readonly registerRestrictPointer: (scope: RuntimeScope, binding: Binding, reference: ObjectReference) => void;
  readonly jump: (
    frame: Frame,
    target: number,
    vmScopeExit?: readonly VariablyModifiedIdentifier[],
    vmScopeTarget?: readonly VariablyModifiedIdentifier[],
    at?: Location,
  ) => void;
  readonly evaluateFullExpression: (
    expression: Expression, frame: Frame, consume: () => void, depth?: number, used?: boolean,
  ) => void;
  readonly materialize: (evaluation: Evaluation, at: Location) => CValue;
  readonly valueForType: (value: CValue, type: CType, at: Location) => CValue;
  readonly activePointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly activeUnknownPointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly truthValue: (value: CValue) => boolean;
  readonly allocateDebugObject: (allocate: () => ObjectReference, metadata: DebugObjectMetadata) => ObjectReference;
  readonly publishAutomaticBinding: (
    frame: Frame, scope: RuntimeScope, binding: Binding, reference: ObjectReference,
  ) => void;
  readonly hasPersistentDuration: (binding: Binding) => boolean;
  readonly invokeBuiltin: (
    name: string, args: CValue[], resultType: CType | undefined, at: Location, frame: Frame,
  ) => LibraryBuiltinResult;
  readonly isBuiltinContinuation: (value: LibraryBuiltinResult) => value is ResumableLibraryBuiltin;
  readonly continueLibraryGenerator: (
    generator: ResumableLibraryBuiltin, effects: Evaluation, at: Location,
  ) => void;
  readonly defaultArgumentPromotion: (value: CValue, at: Location) => CValue;
  readonly defaultReturn: (type: CType, at: Location) => CValue;
  readonly endVaCursor: (id: number, cursor: VaCursor, at: Location) => void;
  readonly plain: (value: CValue) => Evaluation;
  readonly integer: (value: bigint | number | boolean, type?: CType) => CValue;
}

export interface VmDispatchRuntime {
  readonly step: (frame: Frame) => void;
  readonly invoke: (
    compiled: CompiledFunction,
    args: CValue[],
    at: Location,
    used?: boolean,
    argumentPointerBases?: readonly ReadonlySet<number>[],
    argumentUnknownPointerBases?: readonly ReadonlySet<number>[],
  ) => void;
}
