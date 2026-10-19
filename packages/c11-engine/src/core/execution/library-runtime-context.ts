import type { CompiledFunction } from '../bytecode.ts';
import type { CType, CValue, Location, ObjectPointerValue, ObjectReference } from '../internal.ts';
import type { LibraryBuiltinResult, ResumableLibraryBuiltin } from '../library.ts';
import type { StdlibTimeRuntimeContext } from '../stdlib-time-context.ts';
import type { VirtualMemory } from '../memory.ts';
import type { VirtualIO } from '../virtual-io.ts';
import type { DebugPausedResult } from '../types.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { DebugObjectRecord, Evaluation, Frame, VaCursor } from './runtime-types.ts';

export type TerminationMode = 'normal' | 'quick' | 'immediate' | 'abort';

export interface TerminationState {
  mode: TerminationMode;
  status: bigint;
  pending: CValue[];
  completed: boolean;
}

export interface IntegerPointerOrigins {
  known: Set<number>;
  unknown: Set<number>;
}

/** Live VM state and operations needed by library execution and termination. */
export interface LibraryRuntimeContext {
  readonly functions: readonly CompiledFunction[];
  readonly memory: VirtualMemory;
  readonly vaCursors: Map<number, VaCursor>;
  readonly work: Array<() => void>;
  readonly operands: Evaluation[];
  readonly normalTerminationHandlers: CValue[];
  readonly quickTerminationHandlers: CValue[];
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly activeRestrictBases: Map<number, object>;
  readonly libraryContext: StdlibTimeRuntimeContext;
  get runtimeLocation(): Location;
  set runtimeLocation(value: Location);
  get io(): VirtualIO | undefined;
  set io(value: VirtualIO | undefined);
  get debugEvents(): DebugEventCollector | undefined;
  readonly debugObjects: Map<number, DebugObjectRecord> | undefined;
  get awaitingInput(): boolean;
  set awaitingInput(value: boolean);
  get debugPause(): DebugPausedResult | undefined;
  set debugPause(value: DebugPausedResult | undefined);
  get termination(): TerminationState | undefined;
  set termination(value: TerminationState | undefined);
  markerId(value: CValue): number | undefined;
  valueForType(value: CValue, type: CType, at: Location): CValue;
  activePointerBases(bases?: Iterable<number>): Set<number>;
  activeUnknownPointerBases(bases?: Iterable<number>): Set<number>;
  integerPointerOrigins(value: CValue): IntegerPointerOrigins;
  hasIntegerPointerOrigins(origins: IntegerPointerOrigins): boolean;
  rememberIntegerPointerBases(value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>): void;
  allocateDebugHeap(bytes: number, at: Location, alignment?: number): ObjectPointerValue | null;
  reallocateDebugHeap(pointer: ObjectPointerValue | null, bytes: number, at: Location): ObjectPointerValue | null;
  commitDebugObjectDelete(reference: ObjectReference, at: Location, frameId: number | null, scopeId: number | null): void;
  plain(value: CValue): Evaluation;
  integer(value: bigint | number | boolean, type?: CType): CValue;
  invoke(
    compiled: CompiledFunction,
    args: CValue[],
    at: Location,
    used?: boolean,
    argumentPointerBases?: readonly ReadonlySet<number>[],
    argumentUnknownPointerBases?: readonly ReadonlySet<number>[],
  ): void;
}

export interface LibraryRuntime {
  readonly cursorFromHandle: (handle: CValue, at: Location, allowIndeterminate?: boolean) => { id: number; cursor: VaCursor };
  readonly storeVaCursor: (destination: CValue, owner: Frame, args: readonly CValue[], index: number, at: Location) => void;
  readonly endVaCursor: (id: number, cursor: VaCursor, at: Location) => void;
  readonly invokeBuiltin: (name: string, args: CValue[], resultType: CType | undefined, at: Location, frame: Frame) => LibraryBuiltinResult;
  readonly defaultArgumentPromotion: (value: CValue, at: Location) => CValue;
  readonly callbackTarget: (callee: CValue, label: string, at: Location) => CompiledFunction;
  readonly scheduleTerminationHandler: (at: Location) => void;
  readonly startTermination: (mode: TerminationMode, status: bigint, at: Location) => void;
  readonly continueLibraryGenerator: (
    generator: ResumableLibraryBuiltin,
    effects: Evaluation,
    at: Location,
    response?: CValue,
  ) => void;
  readonly defaultReturn: (type: CType, at: Location) => CValue;
}
