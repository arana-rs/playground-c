import { failure } from '../internal.ts';
import type { Binding, Location, ObjectPointerValue, ObjectReference } from '../internal.ts';
import type { DebugObjectMetadata, DebugObjectRecord, Frame, RuntimeScope } from './runtime-types.ts';
import { debugTypeSummary } from './debug-format.ts';
import type { DebugObjectRuntime, DebugObjectRuntimeContext } from './debug-object-runtime-context.ts';

export function createDebugObjectRuntime(context: DebugObjectRuntimeContext): DebugObjectRuntime {
  const createDebugObjectRecord = (reference: ObjectReference, metadata: DebugObjectMetadata): DebugObjectRecord => {
    const description = context.memory.describeObject(reference, metadata.location);
    const record: DebugObjectRecord = {
      objectId: description.objectId,
      allocationId: description.allocationId,
      duration: metadata.duration,
      origin: metadata.origin,
      typeSummary: metadata.typeSummary,
      addressVirtual: description.addressVirtual,
      size: description.size,
      frameId: metadata.frameId,
      scopeId: metadata.scopeId,
      readOnly: metadata.readOnly === true || context.memory.isReadOnly(reference, metadata.location),
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
    };
    context.debugObjects!.set(record.allocationId, record);
    context.debugObjectLocations!.set(record.allocationId, metadata.location);
    context.debugEvents!.commit({
      kind: 'object-create',
      objectId: record.objectId,
      allocationId: record.allocationId,
      duration: record.duration,
      origin: record.origin,
      ...(record.name === undefined ? {} : { name: record.name }),
      typeSummary: record.typeSummary,
      addressVirtual: record.addressVirtual,
      size: record.size,
      location: metadata.location,
      frameId: metadata.frameId,
      scopeId: metadata.scopeId,
    });
    return record;
  };

  const allocateDebugObject = (
    allocate: () => ObjectReference,
    metadata: DebugObjectMetadata,
  ): ObjectReference => {
    const debugEvents = context.debugEvents;
    if (!debugEvents) return allocate();
    debugEvents.reserve(metadata.location);
    try {
      const reference = allocate();
      createDebugObjectRecord(reference, metadata);
      return reference;
    } catch (error) {
      debugEvents.cancel();
      throw error;
    }
  };

  const publishDebugObject = (reference: ObjectReference, metadata: DebugObjectMetadata): void => {
    const debugEvents = context.debugEvents;
    const debugObjects = context.debugObjects;
    if (!debugEvents || !debugObjects || debugObjects.has(reference.allocationId)) return;
    debugEvents.reserve(metadata.location);
    try {
      createDebugObjectRecord(reference, metadata);
    } catch (error) {
      debugEvents.cancel();
      throw error;
    }
  };

  const publishAutomaticBinding = (
    frame: Frame,
    scope: RuntimeScope,
    binding: Binding,
    reference: ObjectReference,
  ): void => {
    if (context.hasPersistentDuration(binding)) return;
    publishDebugObject(reference, {
      duration: 'automatic', origin: binding.isParameter ? 'parameter' : 'variable',
      typeSummary: debugTypeSummary(binding.type, context.ir.aggregates),
      location: binding.location, frameId: frame.frameId, scopeId: scope.scopeId, name: binding.name,
      readOnly: binding.isConst === true,
    });
  };

  const allocateDebugHeap = (bytes: number, at: Location, alignment = 16): ObjectPointerValue | null => {
    const allocate = () => alignment === 16
      ? context.memory.allocateRaw(bytes, at)
      : context.memory.allocateRawAligned(bytes, alignment, at);
    const debugEvents = context.debugEvents;
    if (!debugEvents || bytes === 0) return allocate();
    debugEvents.reserve(at);
    try {
      const pointer = allocate();
      if (!pointer) {
        debugEvents.cancel();
        return null;
      }
      const reference = context.memory.rootReference(pointer.allocationId);
      if (!reference) failure('ENGINE_INTERNAL_ERROR', 'Missing root for a newly created heap allocation.', at);
      createDebugObjectRecord(reference, {
        duration: 'heap', origin: 'heap', typeSummary: 'untyped heap block', location: at,
        frameId: null, scopeId: null,
      });
      return pointer;
    } catch (error) {
      debugEvents.cancel();
      throw error;
    }
  };

  const reallocateDebugHeap = (
    pointer: ObjectPointerValue | null,
    bytes: number,
    at: Location,
  ): ObjectPointerValue | null => {
    const debugEvents = context.debugEvents;
    const debugObjects = context.debugObjects;
    if (!debugEvents || !debugObjects || pointer === null) {
      return pointer === null ? allocateDebugHeap(bytes, at) : context.memory.reallocateRaw(pointer, bytes, at);
    }

    const oldReference = context.memory.canFree(pointer) ? context.memory.rootReference(pointer.allocationId) : undefined;
    if (!oldReference) return context.memory.reallocateRaw(pointer, bytes, at);

    const hasOldRecord = debugObjects.has(pointer.allocationId);
    const reservedEvents = bytes === 0 ? Number(hasOldRecord) : Number(hasOldRecord) + 1;
    debugEvents.reserveMany(reservedEvents, at);

    let resized: ObjectPointerValue | null;
    try {
      resized = context.memory.reallocateRaw(pointer, bytes, at);
    } catch (error) {
      debugEvents.cancelMany(reservedEvents);
      throw error;
    }
    if (bytes === 0 || resized === null) {
      if (resized === null && bytes > 0) {
        debugEvents.cancelMany(reservedEvents);
      } else if (hasOldRecord && oldReference) {
        commitDebugObjectDelete(oldReference, at, null, null);
      }
      return null;
    }

    const newReference = context.memory.rootReference(resized.allocationId);
    if (!newReference) {
      debugEvents.cancelMany(reservedEvents);
      failure('ENGINE_INTERNAL_ERROR', 'Missing root for a newly reallocated heap object.', at);
    }
    if (hasOldRecord && oldReference) commitDebugObjectDelete(oldReference, at, null, null);
    createDebugObjectRecord(newReference, {
      duration: 'heap', origin: 'heap', typeSummary: 'untyped heap block', location: at,
      frameId: null, scopeId: null,
    });
    return resized;
  };

  const commitDebugObjectDelete = (
    reference: ObjectReference,
    at: Location,
    frameId: number | null,
    scopeId: number | null,
  ): void => {
    const debugEvents = context.debugEvents;
    const debugObjects = context.debugObjects;
    if (!debugEvents || !debugObjects) return;
    const record = debugObjects.get(reference.allocationId);
    if (!record) return;
    debugEvents.commit({
      kind: 'object-delete', objectId: record.objectId, allocationId: record.allocationId,
      duration: record.duration, origin: record.origin,
      ...(record.name === undefined ? {} : { name: record.name }),
      typeSummary: record.typeSummary, addressVirtual: record.addressVirtual, size: record.size,
      location: at, frameId, scopeId,
    });
    debugObjects.delete(reference.allocationId);
  };

  return {
    allocateDebugObject,
    publishDebugObject,
    publishAutomaticBinding,
    allocateDebugHeap,
    reallocateDebugHeap,
    commitDebugObjectDelete,
  };
}
