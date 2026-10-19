import type { Binding, Location, ObjectReference } from '../internal.ts';
import type { VirtualMemory } from '../memory.ts';
import type { RuntimeScope, RestrictObservation } from './runtime-types.ts';

export interface RestrictRuntimeContext {
  readonly memory: VirtualMemory;
  readonly activeRestrictBases: Map<number, object>;
  readonly restrictBaseByPointerObject: Map<number, number>;
  readonly restrictPointerObjectByBase: Map<number, number>;
  readonly restrictBaseParents: Map<number, Set<number>>;
  readonly restrictObservations: Map<number, Map<string, RestrictObservation>>;
  get nextRestrictBaseId(): number;
  set nextRestrictBaseId(value: number);
  readonly activePointerBases: (bases?: Iterable<number>) => Set<number>;
  readonly activeUnknownPointerBases: (bases?: Iterable<number>) => Set<number>;
}

export interface RestrictRuntime {
  readonly registerRestrictPointer: (scope: RuntimeScope, binding: Binding, reference: ObjectReference) => void;
  readonly relatedRestrictBases: (base: number) => Set<number>;
  readonly observeRestrictRange: (
    allocationId: number,
    byteOffset: number,
    byteCount: number,
    addressBases: Iterable<number> | undefined,
    unknownAddressBases: Iterable<number> | undefined,
    write: boolean,
    at: Location,
    bitMask?: bigint,
  ) => void;
  readonly observeRestrictAddress: (
    pointer: { readonly allocationId: number; readonly byteOffset: number },
    bases: Iterable<number> | undefined,
    unknownBases: Iterable<number> | undefined,
    byteCount: number,
    write: boolean,
    at: Location,
  ) => void;
  readonly observeRestrictAccess: (
    reference: ObjectReference,
    addressBases: Iterable<number> | undefined,
    unknownAddressBases: Iterable<number> | undefined,
    write: boolean,
    at: Location,
  ) => void;
}
