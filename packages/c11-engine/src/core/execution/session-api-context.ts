import type {
  DebugArrayInspection, DebugAggregateInspection, DebugHeapObjectSnapshot,
  DebugLimitResult, DebugPausedResult, DebugPointerSnapshot, DebugProgress,
  DebugScalarSnapshot, DebugSessionOptions, DebugSourceLocation,
  DebugStaticObjectInspectionOptions, DebugStaticObjectSnapshot,
  EngineMetrics, ExecuteProgress, ExecuteResult,
} from '../types.ts';
import type { Location } from '../internal.ts';
import type { VirtualIO } from '../virtual-io.ts';
import type { DebugEventCollector } from './debug-events.ts';
import type { Frame } from './runtime-types.ts';

/** Live session state and callbacks used to expose the execution API. */
export interface RuntimeSessionApiContext {
  readonly interactiveStdin: boolean;
  readonly debugOptions: DebugSessionOptions | undefined;
  readonly metrics: EngineMetrics;
  get terminalResult(): ExecuteResult | DebugLimitResult | undefined;
  set terminalResult(value: ExecuteResult | DebugLimitResult | undefined);
  get runRuntime(): (() => ExecuteProgress | DebugProgress) | undefined;
  get awaitingInput(): boolean;
  set awaitingInput(value: boolean);
  get pendingInputError(): unknown;
  set pendingInputError(value: unknown);
  get stdinEnded(): boolean;
  set stdinEnded(value: boolean);
  get debugLocation(): Location | null;
  set debugLocation(value: Location | null);
  get debugPause(): DebugPausedResult | undefined;
  set debugPause(value: DebugPausedResult | undefined);
  get debugInputSuspended(): boolean;
  set debugInputSuspended(value: boolean);
  get debugStepStartLocation(): Location | undefined;
  set debugStepStartLocation(value: Location | undefined);
  get debugStepExecuted(): boolean;
  set debugStepExecuted(value: boolean);
  get debugStepActive(): boolean;
  set debugStepActive(value: boolean);
  get debugVisitedInstructions(): Map<Frame, Set<number>> | undefined;
  set debugVisitedInstructions(value: Map<Frame, Set<number>> | undefined);
  get io(): VirtualIO | undefined;
  get runtimeLocation(): Location;
  get debugEvents(): DebugEventCollector | undefined;
  get inspectDebugScalars(): (() => readonly DebugScalarSnapshot[]) | undefined;
  get inspectDebugPointers(): (() => readonly DebugPointerSnapshot[]) | undefined;
  get inspectDebugStaticObjects(): (
    (options?: DebugStaticObjectInspectionOptions) => readonly DebugStaticObjectSnapshot[]
  ) | undefined;
  get inspectDebugArrays(): (() => DebugArrayInspection) | undefined;
  get inspectDebugAggregates(): (() => DebugAggregateInspection) | undefined;
  get inspectDebugHeapObjects(): (() => readonly DebugHeapObjectSnapshot[]) | undefined;
  readonly now: () => number;
  readonly output: () => { readonly stdout: Uint8Array; readonly stderr: Uint8Array };
  readonly exposedDebugLocation: () => DebugSourceLocation | null;
  readonly resultForError: (error: unknown) => ExecuteResult | DebugLimitResult;
}
