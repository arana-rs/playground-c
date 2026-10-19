import { DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS } from '../types.ts';
import type {
  DebugArrayElementSnapshot, DebugArrayInspection, DebugArraySnapshot,
} from '../types.ts';
import { failure } from '../internal.ts';
import { arrayType, isArithmetic, isArray, isPointer, sizeOfType, typeName } from '../type-system.ts';
import { debugScalarValue } from './debug-format.ts';
import type { DebugInspectionContext, DebugInspectionFactories } from './debug-inspection-context.ts';

type PointerTargetSnapshotter = typeof import('./debug-inspection-context.ts').snapshotPointerTarget;

export function createArrayInspector(
  context: DebugInspectionContext,
  snapshotPointerTarget: PointerTargetSnapshotter,
): DebugInspectionFactories['inspectArrays'] {
  const { ir, location, memory, debugObjects, debugObjectLocations } = context;

  return (): DebugArrayInspection => {
    const candidates = [...debugObjects.values()].flatMap((record) => {
      if ((record.duration !== 'automatic' && record.duration !== 'static' && record.duration !== 'thread-local') ||
          (record.origin !== 'variable' && record.origin !== 'string-literal')) return [];
      const reference = memory.rootReference(record.allocationId);
      const array = reference ? arrayType(reference.type) : undefined;
      return reference && array && array.length !== null
        ? [{ record, reference }]
        : [];
    });
    const visible = candidates.slice(0, context.maxArrayObjects);
    const arrays = visible.map(({ record, reference }): DebugArraySnapshot => {
      const array = arrayType(reference.type);
      if (!array || array.length === null) {
        failure('ENGINE_INTERNAL_ERROR', 'The array descriptor lost its complete type.', debugObjectLocations.get(record.allocationId) ?? location);
      }
      const length = array.length;
      const elementType = array.element;
      const elementTypeName = typeName(elementType, ir.aggregates);
      const at = debugObjectLocations.get(record.allocationId) ?? location;
      let status: DebugArraySnapshot['status'];
      if (isArray(elementType)) status = 'multidimensional';
      else if (!isArithmetic(elementType) && !isPointer(elementType)) status = 'unsupported-element-type';
      else if (length > (isPointer(elementType)
        ? Math.min(context.maxElementsPerArray, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxElementsPerArray)
        : context.maxElementsPerArray)) status = 'too-many-elements';
      else status = 'available';

      let elements: readonly DebugArrayElementSnapshot[] = Object.freeze([]);
      if (status === 'available') {
        const elementSize = sizeOfType(elementType, ir.aggregates, at);
        const cells: DebugArrayElementSnapshot[] = [];
        for (let index = 0; index < length; index += 1) {
          const address = `0x${(record.addressVirtual + BigInt(index) * BigInt(elementSize)).toString(16)}`;
          if (isPointer(elementType)) {
            const inspected = memory.inspectArrayPointerElement(reference, index, at);
            if (!inspected) failure('ENGINE_INTERNAL_ERROR', 'The pointer array cell could not be inspected.', at);
            const target = snapshotPointerTarget(context, elementType, inspected.target);
            cells.push(Object.freeze({
              key: `${record.allocationId}:${index}`,
              index,
              address,
              type: elementTypeName,
              initialized: inspected.initialized,
              displayValue: inspected.address === undefined ? '?' : `0x${inspected.address.toString(16)}`,
              valueTruncated: false,
              kind: 'pointer',
              pointerStatus: inspected.status,
              ...(target === undefined ? {} : { target }),
            }) satisfies DebugArrayElementSnapshot);
            continue;
          }
          const inspected = memory.inspectArrayElement(reference, index, at);
          const initialized = inspected?.initialized === true && inspected.value !== undefined;
          const fullValue = initialized ? debugScalarValue(elementType, inspected.value!) : '?';
          const valueTruncated = initialized && fullValue.length > context.maxValueChars;
          cells.push(Object.freeze({
            key: `${record.allocationId}:${index}`,
            index,
            address,
            type: elementTypeName,
            initialized,
            displayValue: valueTruncated ? fullValue.slice(0, context.maxValueChars) : fullValue,
            valueTruncated,
          }) satisfies DebugArrayElementSnapshot);
        }
        elements = Object.freeze(cells);
      }
      return Object.freeze({
        rootId: record.allocationId,
        ...(record.name === undefined ? {} : { name: record.name }),
        origin: record.origin as DebugArraySnapshot['origin'],
        duration: record.duration as DebugArraySnapshot['duration'],
        region: record.duration === 'automatic' || record.duration === 'compound-literal' ? 'stack' : 'static',
        frameId: record.frameId,
        scopeId: record.scopeId,
        type: typeName(reference.type, ir.aggregates),
        elementType: elementTypeName,
        address: `0x${record.addressVirtual.toString(16)}`,
        size: record.size,
        length,
        readOnly: record.readOnly || memory.isReadOnly(reference, at),
        status,
        elements,
      }) satisfies DebugArraySnapshot;
    });
    return Object.freeze({ arrays: Object.freeze(arrays), omittedObjects: candidates.length - visible.length });
  };
}
