import type {
  DebugAggregateInspection, DebugArrayInspection, DebugEvent,
  DebugObjectDuration, DebugObjectOrigin, DebugProgress, DebugScalarSnapshot,
  DebugPointerSnapshot, DebugStaticObjectInspectionOptions, DebugStaticObjectSnapshot,
  DebugHeapObjectSnapshot, DebugSourceLocation, ExecuteProgress,
} from '../types.ts';
import type {
  ArrayCType, Binding, CValue, Location, ObjectReference,
} from '../internal.ts';
import type { CompiledFunction, Scope } from '../bytecode.ts';

export interface Cell { binding: Binding; reference: ObjectReference }
export interface RuntimeScope {
  layout: Scope;
  token: object;
  scopeId: number;
  cells: number[];
  vlaTypeKeys: ArrayCType[];
  restrictBases: number[];
}
export interface Frame {
  compiled: CompiledFunction;
  frameId: number | null;
  pc: number;
  returnLocation?: Location;
  scopes: RuntimeScope[];
  fullExpressionToken?: object;
  cells: Map<number, Cell>;
  vlaLengths: Map<ArrayCType, number>;
  args: CValue[];
  argumentPointerBases?: readonly ReadonlySet<number>[];
  argumentUnknownPointerBases?: readonly ReadonlySet<number>[];
  variadicArgs: CValue[];
  vaCursorIds: Set<number>;
  temporaryObjects: ObjectReference[];
  returned: boolean;
  result?: CValue;
  resultPointerBases?: Set<number>;
  resultUnknownPointerBases?: Set<number>;
}
export interface DebugObjectMetadata {
  readonly duration: DebugObjectDuration;
  readonly origin: DebugObjectOrigin;
  readonly typeSummary: string;
  readonly location: Location;
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly name?: string;
  readonly readOnly?: boolean;
}
export interface DebugObjectRecord {
  readonly objectId: number;
  readonly allocationId: number;
  readonly duration: DebugObjectDuration;
  readonly origin: DebugObjectOrigin;
  readonly typeSummary: string;
  readonly addressVirtual: bigint;
  readonly size: number;
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly name?: string;
  readonly readOnly: boolean;
}
export interface RuntimeSession {
  resume(): ExecuteProgress | DebugProgress;
  appendStdin?: (bytes: Uint8Array) => void;
  endStdin?: () => void;
  currentLocation?: () => DebugSourceLocation | null;
  drainEvents?: () => readonly DebugEvent[];
  inspectScalars?: () => readonly DebugScalarSnapshot[];
  inspectPointers?: () => readonly DebugPointerSnapshot[];
  inspectStaticObjects?: (options?: DebugStaticObjectInspectionOptions) => readonly DebugStaticObjectSnapshot[];
  inspectArrays?: () => DebugArrayInspection;
  inspectAggregates?: () => DebugAggregateInspection;
  inspectHeapObjects?: () => readonly DebugHeapObjectSnapshot[];
}
export interface VaCursor {
  frame: Frame;
  args: readonly CValue[];
  index: number;
  active: boolean;
  indeterminate: boolean;
  marker: ObjectReference;
}
export interface Access { read: boolean; write: boolean; name: string }
export interface RestrictObservation {
  accessedViaBaseMask: number;
  independentAccessMask: number;
  unknownAccessMask: number;
  modifiedMask: number;
}
export interface Evaluation {
  value?: CValue;
  reference?: ObjectReference;
  label?: string;
  pointerBases?: Set<number>;
  unknownPointerBases?: Set<number>;
  addressBases?: Set<number>;
  unknownAddressBases?: Set<number>;
  accesses: Map<number, Access>;
  pendingWrites: Set<number>;
}
