import { DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS } from '../types.ts';
import type {
  DebugAggregateInspection, DebugAggregateMemberSnapshot, DebugAggregatePaddingSnapshot,
  DebugAggregateSnapshot, DebugAggregateStatus, DebugArrayElementSnapshot,
} from '../types.ts';
import { failure } from '../internal.ts';
import {
  aggregateType, arrayType, isAggregate, isArithmetic, isArray, isPointer, sizeOfType, typeName,
} from '../type-system.ts';
import { debugScalarValue } from './debug-format.ts';
import type { DebugInspectionContext, DebugInspectionFactories } from './debug-inspection-context.ts';

type PointerTargetSnapshotter = typeof import('./debug-inspection-context.ts').snapshotPointerTarget;

export function createAggregateInspector(
  context: DebugInspectionContext,
  snapshotPointerTarget: PointerTargetSnapshotter,
): DebugInspectionFactories['inspectAggregates'] {
  const { ir, location, memory, debugObjects, debugObjectLocations } = context;

  return (): DebugAggregateInspection => {
    const candidates = [...debugObjects.values()].flatMap((record) => {
      if ((record.duration !== 'automatic' && record.duration !== 'static' && record.duration !== 'thread-local' && record.duration !== 'heap') ||
          (record.origin !== 'variable' && record.origin !== 'parameter')) return [];
      const reference = memory.rootReference(record.allocationId);
      return reference && isAggregate(reference.type) ? [{ record, reference }] : [];
    });
    const heapCandidates = memory.heapAggregateReferences().flatMap((reference) => {
      const record = debugObjects.get(reference.allocationId);
      return record && isAggregate(reference.type) && !candidates.some((candidate) => candidate.record.allocationId === record.allocationId)
        ? [{ record, reference }]
        : [];
    });
    const allCandidates = [...candidates, ...heapCandidates];
    const visible = allCandidates.slice(0, context.maxArrayObjects);
    const aggregates = visible.map(({ record, reference }): DebugAggregateSnapshot => {
      if (!isAggregate(reference.type)) {
        failure('ENGINE_INTERNAL_ERROR', 'The aggregate descriptor lost its type.', debugObjectLocations.get(record.allocationId) ?? location);
      }
      const aggregateDescriptor = aggregateType(reference.type);
      const definition = aggregateDescriptor && ir.aggregates.find((candidate) => candidate.id === aggregateDescriptor.id);
      if (!definition?.complete || definition.size === undefined) {
        failure('ENGINE_INTERNAL_ERROR', 'The aggregate descriptor has no complete layout.', debugObjectLocations.get(record.allocationId) ?? location);
      }
      const at = debugObjectLocations.get(record.allocationId) ?? location;
      const view = memory.describeObjectView(reference, at);
      const viewKeyPrefix = view.objectId === record.allocationId
        ? `${record.allocationId}`
        : `${record.allocationId}:${view.objectId}`;
      let status: DebugAggregateStatus = definition.kind === 'union'
        ? 'unsupported-union'
        : definition.members.length > DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers
          ? 'too-many-members'
          : 'available';

      let members: readonly DebugAggregateMemberSnapshot[] = Object.freeze([]);
      let padding: readonly DebugAggregatePaddingSnapshot[] = Object.freeze([]);
      const visibleMembers = definition.members.filter((member) => !(member.bitField?.width === 0 && !member.name));
      if (status === 'available') {
        members = Object.freeze(visibleMembers.map((member): DebugAggregateMemberSnapshot => {
          const flexibleExtent = member.flexibleArray ? memory.flexibleArrayExtent(reference, member.index, member.location) : undefined;
          const flexibleType = member.flexibleArray ? arrayType(member.type) : undefined;
          const flexibleArray = flexibleExtent && flexibleType ? (() => {
            const elementType = flexibleType.element;
            const supported = isArithmetic(elementType);
            const visibleElementCount = supported ? Math.min(flexibleExtent.length, context.maxElementsPerArray) : 0;
            const elements: DebugArrayElementSnapshot[] = [];
            for (let index = 0; index < visibleElementCount; index += 1) {
              const inspected = memory.inspectFlexibleArrayElement(reference, member.index, index, member.location);
              const initialized = inspected?.initialized === true && inspected.value !== undefined;
              const fullValue = initialized ? debugScalarValue(elementType, inspected.value!) : '?';
              const valueTruncated = initialized && fullValue.length > context.maxValueChars;
              const addressOffset = BigInt(definition.flexibleOffset!) + BigInt(index) * BigInt(flexibleExtent.elementSize);
              elements.push(Object.freeze({
                key: `${viewKeyPrefix}:${member.index}:flex:${index}`,
                index,
                address: `0x${(view.addressVirtual + addressOffset).toString(16)}`,
                type: typeName(elementType, ir.aggregates),
                initialized,
                displayValue: valueTruncated ? fullValue.slice(0, context.maxValueChars) : fullValue,
                valueTruncated,
              }) satisfies DebugArrayElementSnapshot);
            }
            return Object.freeze({
              ...flexibleExtent,
              status: !supported ? 'unsupported-element-type' : flexibleExtent.length > context.maxElementsPerArray ? 'too-many-elements' : 'available',
              elements: Object.freeze(elements),
              omittedElements: supported ? flexibleExtent.length - elements.length : 0,
            });
          })() : undefined;
          const memberSize = member.bitField
            ? member.bitField.storageUnitSize
            : member.flexibleArray
              ? 0
              : sizeOfType(member.type, ir.aggregates, member.location);
          const memberAddress = `0x${(view.addressVirtual + BigInt(member.offset)).toString(16)}`;
          const common = {
            key: `${viewKeyPrefix}:${member.index}`,
            index: member.index,
            name: member.name,
            type: typeName(member.type, ir.aggregates),
            offset: member.offset,
            size: memberSize,
            ...(member.bitField ? {
              bitWidth: member.bitField.width,
              bitOffset: member.bitField.bitOffset,
              storageUnitSize: member.bitField.storageUnitSize,
            } : {}),
            ...(flexibleArray ? { flexibleArray } : {}),
            address: memberAddress,
          };
          if (member.flexibleArray) return Object.freeze({
            ...common,
            kind: 'unsupported',
            initialized: null,
            displayValue: null,
            unsupportedReason: 'flexible-array',
          }) satisfies DebugAggregateMemberSnapshot;
          if (isArithmetic(member.type)) {
            const inspected = memory.inspectAggregateScalar(reference, member.index, member.location);
            return Object.freeze({
              ...common,
              kind: 'arithmetic',
              initialized: inspected.initialized,
              displayValue: inspected.initialized && inspected.value !== undefined
                ? debugScalarValue(member.type, inspected.value)
                : '?',
            }) satisfies DebugAggregateMemberSnapshot;
          }
          if (isPointer(member.type)) {
            const inspected = memory.inspectAggregatePointer(reference, member.index, member.location);
            const target = snapshotPointerTarget(context, member.type, inspected.target);
            return Object.freeze({
              ...common,
              kind: 'pointer',
              initialized: inspected.initialized,
              displayValue: inspected.address === undefined ? '?' : `0x${inspected.address.toString(16)}`,
              pointerStatus: inspected.status,
              ...(target === undefined ? {} : { target }),
            }) satisfies DebugAggregateMemberSnapshot;
          }
          return Object.freeze({
            ...common,
            kind: 'unsupported',
            initialized: null,
            displayValue: null,
            unsupportedReason: isArray(member.type) ? 'array' : 'aggregate',
          }) satisfies DebugAggregateMemberSnapshot;
        }));

        const paddingRanges: DebugAggregatePaddingSnapshot[] = [];
        let endOfLastMember = 0;
        for (const member of definition.members) {
          if (member.offset > endOfLastMember) {
            paddingRanges.push(Object.freeze({
              key: `${viewKeyPrefix}:padding:${endOfLastMember}`,
              offset: endOfLastMember,
              size: member.offset - endOfLastMember,
            }));
          }
          const memberEnd = member.flexibleArray
            ? member.offset
            : member.bitField
              ? member.offset + member.bitField.storageUnitSize
              : member.offset + sizeOfType(member.type, ir.aggregates, member.location);
          endOfLastMember = Math.max(endOfLastMember, memberEnd);
        }
        if (definition.size! > endOfLastMember) {
          paddingRanges.push(Object.freeze({
            key: `${viewKeyPrefix}:padding:${endOfLastMember}`,
            offset: endOfLastMember,
            size: definition.size! - endOfLastMember,
          }));
        }
        padding = Object.freeze(paddingRanges);
      }

      return Object.freeze({
        rootId: record.allocationId,
        ...(view.objectId === record.allocationId ? {} : { viewId: view.objectId }),
        ...(record.name === undefined ? {} : { name: record.name }),
        origin: record.origin as DebugAggregateSnapshot['origin'],
        duration: record.duration as DebugAggregateSnapshot['duration'],
        region: record.duration === 'heap' ? 'heap' : record.duration === 'automatic' || record.duration === 'compound-literal' ? 'stack' : 'static',
        frameId: record.frameId,
        scopeId: record.scopeId,
        type: typeName(reference.type, ir.aggregates),
        kind: definition.kind,
        address: `0x${view.addressVirtual.toString(16)}`,
        size: view.size,
        readOnly: record.readOnly || memory.isReadOnly(reference, at),
        memberCount: visibleMembers.length,
        status,
        members,
        padding,
      }) satisfies DebugAggregateSnapshot;
    });
    return Object.freeze({ aggregates: Object.freeze(aggregates), omittedObjects: allCandidates.length - visible.length });
  };
}
