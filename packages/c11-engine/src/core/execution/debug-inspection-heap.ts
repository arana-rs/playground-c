import type { DebugHeapObjectSnapshot } from '../types.ts';
import type { DebugInspectionContext, DebugInspectionFactories } from './debug-inspection-context.ts';

export function createHeapInspector(
  context: DebugInspectionContext,
): DebugInspectionFactories['inspectHeapObjects'] {
  return (): readonly DebugHeapObjectSnapshot[] => Object.freeze(
    [...context.debugObjects.values()]
      .filter((record) => record.duration === 'heap')
      .sort((left, right) => left.addressVirtual < right.addressVirtual ? -1 : left.addressVirtual > right.addressVirtual ? 1 : 0)
      .map((record) => Object.freeze({
        id: record.allocationId,
        address: `0x${record.addressVirtual.toString(16)}`,
        size: record.size,
        origin: 'heap',
      }) satisfies DebugHeapObjectSnapshot),
  );
}
