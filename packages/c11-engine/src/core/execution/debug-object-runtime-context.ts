import type { Binding, Location, ObjectPointerValue, ObjectReference, ProgramIR } from '../internal.ts';
import type { VirtualMemory } from '../memory.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { DebugObjectMetadata, DebugObjectRecord, Frame, RuntimeScope } from './runtime-types.ts';

/** Live state used to publish debug object lifecycle events and track heap blocks. */
export interface DebugObjectRuntimeContext {
  readonly ir: ProgramIR;
  readonly memory: VirtualMemory;
  readonly debugObjects: Map<number, DebugObjectRecord> | undefined;
  readonly debugObjectLocations: Map<number, Location> | undefined;
  readonly hasPersistentDuration: (binding: Binding) => boolean;
  get debugEvents(): DebugEventCollector | undefined;
}

export interface DebugObjectRuntime {
  readonly allocateDebugObject: (allocate: () => ObjectReference, metadata: DebugObjectMetadata) => ObjectReference;
  readonly publishDebugObject: (reference: ObjectReference, metadata: DebugObjectMetadata) => void;
  readonly publishAutomaticBinding: (frame: Frame, scope: RuntimeScope, binding: Binding, reference: ObjectReference) => void;
  readonly allocateDebugHeap: (bytes: number, at: Location, alignment?: number) => ObjectPointerValue | null;
  readonly reallocateDebugHeap: (pointer: ObjectPointerValue | null, bytes: number, at: Location) => ObjectPointerValue | null;
  readonly commitDebugObjectDelete: (
    reference: ObjectReference,
    at: Location,
    frameId: number | null,
    scopeId: number | null,
  ) => void;
}
