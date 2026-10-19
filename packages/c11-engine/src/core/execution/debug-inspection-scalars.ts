import type {
  DebugPointerSnapshot, DebugScalarSnapshot, DebugStaticObjectInspectionOptions,
  DebugStaticObjectSnapshot,
} from '../types.ts';
import type { ObjectReference } from '../internal.ts';
import { isArithmetic, isPointer, typeName } from '../type-system.ts';
import { debugScalarValue, debugStringLiteral } from './debug-format.ts';
import {
  snapshotPointerTarget,
  type DebugInspectionContext,
  type DebugInspectionFactories,
} from './debug-inspection-context.ts';
import type { DebugObjectRecord } from './runtime-types.ts';

export function createScalarInspectors(
  context: DebugInspectionContext,
): Pick<DebugInspectionFactories, 'inspectScalars' | 'inspectPointers' | 'inspectStaticObjects'> {
  const {
    ir, location, memory, debugObjects, debugObjectLocations, activeDebugFrames,
    hasPersistentDuration,
  } = context;

  const inspectScalars = (): readonly DebugScalarSnapshot[] => Object.freeze(activeDebugFrames.flatMap((frame) =>
    frame.scopes.flatMap((scope) => scope.cells.flatMap((bindingId) => {
      const cell = frame.cells.get(bindingId);
      if (!cell || hasPersistentDuration(cell.binding) || !isArithmetic(cell.binding.type) ||
          frame.frameId === null || scope.scopeId === 0) return [];
      const record = debugObjects.get(cell.reference.allocationId);
      if (!record) return [];
      const inspected = memory.inspectScalar(cell.reference, cell.binding.location);
      return [Object.freeze({
        id: record.allocationId,
        scopeId: scope.scopeId,
        frameId: frame.frameId,
        name: cell.binding.name,
        origin: record.origin,
        type: typeName(cell.binding.type, ir.aggregates),
        address: `0x${record.addressVirtual.toString(16)}`,
        size: record.size,
        initialized: inspected.initialized,
        displayValue: inspected.initialized && inspected.value !== undefined
          ? debugScalarValue(cell.binding.type, inspected.value)
          : '?',
      }) satisfies DebugScalarSnapshot];
    })),
  ));

  const snapshotPointer = (record: DebugObjectRecord, reference: ObjectReference): DebugPointerSnapshot | undefined => {
    if (!isPointer(reference.type) || record.name === undefined) return undefined;
    const inspected = memory.inspectPointer(reference, debugObjectLocations.get(record.allocationId) ?? location);
    const target = snapshotPointerTarget(context, reference.type, inspected.target);
    return Object.freeze({
      id: record.allocationId,
      scopeId: record.scopeId,
      frameId: record.frameId,
      name: record.name,
      origin: record.origin as DebugPointerSnapshot['origin'],
      duration: record.duration as DebugPointerSnapshot['duration'],
      region: record.duration === 'automatic' || record.duration === 'compound-literal' ? 'stack' : 'static',
      type: typeName(reference.type, ir.aggregates),
      address: `0x${record.addressVirtual.toString(16)}`,
      size: record.size,
      initialized: inspected.initialized,
      displayValue: inspected.address === undefined ? '?' : `0x${inspected.address.toString(16)}`,
      status: inspected.status,
      ...(target === undefined ? {} : { target }),
    }) satisfies DebugPointerSnapshot;
  };

  const inspectPointers = (): readonly DebugPointerSnapshot[] => {
    const automatic = activeDebugFrames.flatMap((frame) => frame.scopes.flatMap((scope) =>
      scope.cells.flatMap((bindingId) => {
        const cell = frame.cells.get(bindingId);
        if (!cell || cell.binding.storageDuration === 'static' || cell.binding.storageDuration === 'thread-local' || !isPointer(cell.binding.type) ||
            frame.frameId === null) return [];
        const record = debugObjects.get(cell.reference.allocationId);
        if (!record) return [];
        const snapshot = snapshotPointer(record, cell.reference);
        return snapshot ? [snapshot] : [];
      }),
    ));
    const staticPointers = [...debugObjects.values()].flatMap((record) => {
      if ((record.duration !== 'static' && record.duration !== 'thread-local') || record.origin !== 'variable' || record.name === undefined) return [];
      const reference = memory.rootReference(record.allocationId);
      if (!reference || !isPointer(reference.type)) return [];
      const snapshot = snapshotPointer(record, reference);
      return snapshot ? [snapshot] : [];
    });
    return Object.freeze([...staticPointers, ...automatic]);
  };

  const inspectStaticObjects = (inspectionOptions?: DebugStaticObjectInspectionOptions): readonly DebugStaticObjectSnapshot[] => {
    if (inspectionOptions !== undefined &&
        (!inspectionOptions || typeof inspectionOptions !== 'object' || Array.isArray(inspectionOptions))) {
      throw new TypeError('inspectStaticObjects requires an options object.');
    }
    for (const key of Object.keys(inspectionOptions ?? {})) {
      if (key !== 'includeStringLiterals') throw new TypeError(`Unknown inspectStaticObjects option: ${key}.`);
    }
    if (inspectionOptions?.includeStringLiterals !== undefined &&
        typeof inspectionOptions.includeStringLiterals !== 'boolean') {
      throw new TypeError('includeStringLiterals must be a boolean.');
    }
    const includeStringLiterals = inspectionOptions?.includeStringLiterals ?? true;
    return Object.freeze([...debugObjects.values()].flatMap<DebugStaticObjectSnapshot>((record) => {
      if ((record.duration !== 'static' && record.duration !== 'thread-local') ||
          (record.origin !== 'variable' && record.origin !== 'string-literal')) return [];
      if (record.origin === 'string-literal' && !includeStringLiterals) return [];
      const reference = memory.rootReference(record.allocationId);
      if (!reference) return [];
      const address = `0x${record.addressVirtual.toString(16)}`;
      if (record.origin === 'variable' && isArithmetic(reference.type)) {
        const at = debugObjectLocations.get(record.allocationId) ?? location;
        const inspected = memory.inspectScalar(reference, at);
        return [Object.freeze({
          id: record.allocationId,
          ...(record.name === undefined ? {} : { name: record.name }),
          origin: record.origin,
          duration: record.duration,
          type: typeName(reference.type, ir.aggregates),
          address,
          size: record.size,
          initialized: inspected.initialized,
          displayValue: inspected.initialized && inspected.value !== undefined
            ? debugScalarValue(reference.type, inspected.value)
            : '?',
        }) satisfies DebugStaticObjectSnapshot];
      }
      if (record.origin === 'string-literal') {
        const bytes = memory.inspectStringLiteral(reference);
        if (!bytes) return [];
        return [Object.freeze({
          id: record.allocationId,
          origin: record.origin,
          duration: record.duration,
          type: record.typeSummary,
          address,
          size: record.size,
          initialized: true,
          displayValue: debugStringLiteral(bytes),
        }) satisfies DebugStaticObjectSnapshot];
      }
      return [];
    }));
  };

  return { inspectScalars, inspectPointers, inspectStaticObjects };
}
