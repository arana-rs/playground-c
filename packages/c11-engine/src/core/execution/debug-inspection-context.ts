import type {
  DebugArrayInspection, DebugAggregateInspection, DebugHeapObjectSnapshot,
  DebugPointerSnapshot, DebugScalarSnapshot, DebugStaticObjectInspectionOptions,
  DebugStaticObjectSnapshot,
} from '../types.ts';
import type { Binding, CType, Location, ProgramIR } from '../internal.ts';
import type { VirtualMemory } from '../memory.ts';
import type { DebugObjectRecord, Frame } from './runtime-types.ts';
import { debugTypeSummary } from './debug-format.ts';
import { pointedToType } from '../type-system.ts';

export interface DebugInspectionContext {
  readonly ir: ProgramIR;
  readonly location: Location;
  readonly memory: VirtualMemory;
  readonly debugObjects: Map<number, DebugObjectRecord>;
  readonly debugObjectLocations: Map<number, Location>;
  readonly activeDebugFrames: Frame[];
  readonly maxArrayObjects: number;
  readonly maxElementsPerArray: number;
  readonly maxValueChars: number;
  readonly hasPersistentDuration: (binding: Binding) => boolean;
}

export function snapshotPointerTarget(
  context: Pick<DebugInspectionContext, 'ir' | 'debugObjects'>,
  pointer: CType,
  targetIdentity: { readonly allocationId: number; readonly byteOffset: number } | undefined,
): DebugPointerSnapshot['target'] {
  if (!targetIdentity) return undefined;
  const targetType = debugTypeSummary(pointedToType(pointer) ?? 'void', context.ir.aggregates);
  const targetRecord = context.debugObjects.get(targetIdentity.allocationId);
  const name = targetIdentity.byteOffset === 0 && targetRecord?.typeSummary === targetType
    ? targetRecord.name
    : undefined;
  return Object.freeze({
    allocationId: targetIdentity.allocationId,
    byteOffset: targetIdentity.byteOffset,
    type: targetType,
    ...(name === undefined ? {} : { name }),
  });
}

export interface DebugInspectionFactories {
  readonly inspectScalars: () => readonly DebugScalarSnapshot[];
  readonly inspectPointers: () => readonly DebugPointerSnapshot[];
  readonly inspectStaticObjects: (options?: DebugStaticObjectInspectionOptions) => readonly DebugStaticObjectSnapshot[];
  readonly inspectArrays: () => DebugArrayInspection;
  readonly inspectAggregates: () => DebugAggregateInspection;
  readonly inspectHeapObjects: () => readonly DebugHeapObjectSnapshot[];
}

export type DebugInspectionFunction = DebugInspectionFactories[keyof DebugInspectionFactories];
