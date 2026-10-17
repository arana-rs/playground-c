import { createDebugSession, createExecutionSession, DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS, execute, prepare, VIRTUAL_HEAP_LAYOUT } from '@playground/c11-engine/core';
import type {
  DebugAggregateInspection, DebugAggregateMemberSnapshot, DebugAggregateSnapshot,
  DebugArrayElementSnapshot, DebugArrayInspection, DebugArraySnapshot, DebugExecutionSession,
  DebugFlexibleArraySnapshot, DebugHeapObjectSnapshot, DebugObjectDuration, DebugPointerSnapshot, DebugProgress, DebugScalarSnapshot, DebugSessionOptions, DebugStaticObjectSnapshot,
  DebugStaticObjectInspectionOptions, ExecuteProgress, ExecutionSession, PrepareResult, SourceProject,
} from '@playground/c11-engine/core';
// @ts-expect-error QualifiedCType is an internal compiler representation, not a public DTO.
type QualifiedTypeMustStayInternal = import('@playground/c11-engine/core').QualifiedCType;

const project: SourceProject = {
    entry: 'main.c',
    files: [{ name: 'main.c', source: 'int main(void) { return 42; }' }],
};
const heapAddressBase: bigint = VIRTUAL_HEAP_LAYOUT.start;
void heapAddressBase;
const arrayInspectionDefault: number = DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxElementsPerArray;
void arrayInspectionDefault;
const aggregateMemberLimit: number = DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers;
void aggregateMemberLimit;
const prepared: PrepareResult = prepare(project);
if (prepared.kind === 'prepared') {
    const hasHeapAllocationCalls: boolean = prepared.program.hasHeapAllocationCalls;
    void hasHeapAllocationCalls;
    const executed = execute(prepared.program);
    if (executed.kind === 'terminated') {
        const code: number = executed.exitCode;
        void code;
    } else {
        const message: string = executed.diagnostics[0].message;
        void message;
    }
  const session: ExecutionSession = createExecutionSession(prepared.program, { io: { stdin: new Uint8Array([65]) } });
  const progress: ExecuteProgress = session.resume();
  if (progress.kind === 'input-needed') {
    const output: Uint8Array = progress.stdout;
    void output;
  }
  session.appendStdin(new Uint8Array([10]));
  session.endStdin();
  const arrayOptions: DebugSessionOptions = { maxObjects: 100, maxElementsPerArray: 10, maxValueChars: 64 };
  const debug: DebugExecutionSession = createDebugSession(prepared.program, undefined, arrayOptions);
  const debugProgress: DebugProgress = debug.resume();
  if (debugProgress.kind === 'input-needed') {
    const debugLocation = debugProgress.location;
    const debugOutput: Uint8Array = debugProgress.stdout;
    void debugLocation;
    void debugOutput;
    debug.appendStdin(new Uint8Array([65]));
  }
  debug.endStdin();
  const scalars: readonly DebugScalarSnapshot[] = debug.inspectScalars();
  const pointers: readonly DebugPointerSnapshot[] = debug.inspectPointers();
  const staticInspectionOptions: DebugStaticObjectInspectionOptions = { includeStringLiterals: false };
  const staticObjects: readonly DebugStaticObjectSnapshot[] = debug.inspectStaticObjects(staticInspectionOptions);
  const arrays: DebugArrayInspection = debug.inspectArrays();
  const aggregates: DebugAggregateInspection = debug.inspectAggregates();
  const firstAggregate: DebugAggregateSnapshot | undefined = aggregates.aggregates[0];
  const firstMember: DebugAggregateMemberSnapshot | undefined = firstAggregate?.members[0];
  void firstMember;
const bitWidth: number | undefined = firstMember?.bitWidth;
const flexibleArray: DebugFlexibleArraySnapshot | undefined = firstMember?.flexibleArray;
const tlsDuration: DebugObjectDuration = 'thread-local';
void bitWidth;
void flexibleArray;
void tlsDuration;
void (null as unknown as QualifiedTypeMustStayInternal);
  const firstArray: DebugArraySnapshot | undefined = arrays.arrays[0];
  const firstElement: DebugArrayElementSnapshot | undefined = firstArray?.elements[0];
  const heapObjects: readonly DebugHeapObjectSnapshot[] = debug.inspectHeapObjects();
  const firstId: number | undefined = scalars[0]?.id;
  void firstId;
  void staticObjects;
  void pointers;
  void firstElement;
  void heapObjects;
}
