import type { CValue, Location, ObjectPointerValue, ObjectReference, ProgramIR } from '../internal.ts';
import type { VirtualMemory } from '../memory.ts';

export interface PointerRuntimeContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  get runtimeLocation(): Location;
  readonly activeRestrictBases: Map<number, object>;
  readonly restrictBaseByPointerObject: Map<number, number>;
  readonly restrictBaseParents: Map<number, Set<number>>;
  readonly pointerOriginsByObject: Map<number, Set<number>>;
  readonly unknownPointerOriginsByObject: Map<number, Set<number>>;
  readonly integerPointerOriginsByObject: Map<number, Set<number>>;
  readonly unknownIntegerPointerOriginsByObject: Map<number, Set<number>>;
  readonly integerPointerOriginReferences: Map<number, ObjectReference>;
  readonly pointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly unknownPointerValueBases: WeakMap<ObjectPointerValue, Set<number>>;
  readonly integerValueBases: WeakMap<CValue, Set<number>>;
  readonly unknownIntegerValueBases: WeakMap<CValue, Set<number>>;
  readonly integer: (value: bigint | number | boolean, type?: CValue['type']) => CValue;
}

export interface IntegerPointerOrigins {
  readonly known: Set<number>;
  readonly unknown: Set<number>;
}

export interface CopiedIntegerPointerOrigin extends IntegerPointerOrigins {
  readonly relativeOffset: number;
  readonly size: number;
}

export interface PointerRuntime {
  readonly valueForType: (value: CValue, type: CValue['type'], at: Location) => CValue;
  readonly activePointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly activeUnknownPointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly unionPointerBases: (...sources: Array<Iterable<number> | undefined>) => Set<number>;
  readonly unionUnknownPointerBases: (...sources: Array<Iterable<number> | undefined>) => Set<number>;
  readonly rememberPointerBases: (value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly rememberIntegerPointerBases: (value: CValue, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly preserveIntegerPointerBases: (source: CValue, target: CValue) => void;
  readonly pointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly unknownPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly setPointerBasesForObject: (reference: ObjectReference, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly integerPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly unknownIntegerPointerBasesForObject: (reference: ObjectReference) => Set<number>;
  readonly setIntegerPointerBasesForObject: (reference: ObjectReference, bases?: Iterable<number>, unknownBases?: Iterable<number>) => void;
  readonly clearIntegerPointerOriginsInRange: (allocationId: number, byteOffset: number, byteCount: number) => void;
  readonly copyIntegerPointerOrigins: (allocationId: number, byteOffset: number, byteCount: number) => readonly CopiedIntegerPointerOrigin[];
  readonly restoreIntegerPointerOrigins: (allocationId: number, byteOffset: number, byteCount: number, copied: readonly CopiedIntegerPointerOrigin[]) => void;
  readonly integerPointerOrigins: (value: CValue) => IntegerPointerOrigins;
  readonly hasIntegerPointerOrigins: (origins: IntegerPointerOrigins) => boolean;
  readonly propagateIntegerPointerOperation: (operator: string, left: CValue, right: CValue | undefined, result: CValue) => void;
}
