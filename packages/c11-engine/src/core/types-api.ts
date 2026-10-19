export interface SourceFile { readonly name: string; readonly source: string }
/** A virtual project. `files` contains translation units and headers; only names
 * listed in `translationUnits` are parsed and linked as C translation units. */
export interface SourceProject {
  readonly entry: string;
  readonly files: readonly SourceFile[];
  /** Ordered C translation units. Omitted means `[entry]`. */
  readonly translationUnits?: readonly string[];
}
export interface RelatedDiagnosticLocation {
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Exclusive end of the related source span, when the source mapping is safe. */
  readonly endLine?: number;
  readonly endColumn?: number;
}
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Exclusive end of the primary token span, when available. */
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly related?: readonly RelatedDiagnosticLocation[];
}
export interface PrepareLimits { maxSourceChars: number | null; maxTokens: number | null; maxPreprocessSteps: number | null; maxDepth: number | null }
export interface ExecuteLimits { maxInstructions: number | null; maxMemoryBytes: number | null; maxIOBytes: number | null; maxDepth: number | null }
export interface PrepareOptions { limits?: Partial<PrepareLimits> }
export type PrepareResource = keyof PrepareLimits;
export interface VirtualInputFile { readonly name: string; readonly data: string | Uint8Array }
/** Session inputs are copied into the engine's bounded virtual I/O system. */
export interface ExecuteIOOptions {
  /** Complete C argv vector. By default it contains the basename of `entry`. */
  readonly argv?: readonly string[];
  /** UTF-8 text or raw bytes buffered before execution starts. */
  readonly stdin?: string | Uint8Array;
  /** Files visible to fopen; these never map to host files. */
  readonly files?: readonly VirtualInputFile[];
}
export interface ExecuteOptions { limits?: Partial<ExecuteLimits>; io?: ExecuteIOOptions }
/** Host services that vary per VM session and must stay outside structured-clone options. */
export interface ExecutionRuntimeServices {
  /** Epoch milliseconds as an integer; queried once by each `time()` or `timespec_get()` call. */
  readonly wallClock?: { readonly nowEpochMilliseconds: () => bigint };
}
export interface EngineMetrics { prepareMs: number; executeMs: number; sourceChars: number; tokenCount: number; preprocessSteps: number; instructionCount: number; peakMemoryBytes: number }
export interface PreparedProgram {
  readonly version: string;
  readonly target: 'x86_64-linux-lp64';
  readonly entry: string;
  readonly translationUnits: readonly string[];
  /** True when any resolved call to a supported heap allocator appears in the linked program. */
  readonly hasHeapAllocationCalls: boolean;
}
export type LimitResource = keyof PrepareLimits | keyof ExecuteLimits;
export interface LimitResult { kind: 'limit'; resource: LimitResource; limit: number; diagnostics: readonly Diagnostic[]; metrics: EngineMetrics }
export type PrepareResult = { kind: 'prepared'; program: PreparedProgram; metrics: EngineMetrics } | { kind: 'prepare-error'; diagnostics: readonly Diagnostic[]; metrics: EngineMetrics } | (LimitResult & { stage: 'prepare' });
export type SyntaxAnalysisResult =
  | { kind: 'ok'; diagnostics: readonly []; metrics: EngineMetrics }
  | { kind: 'error'; diagnostics: readonly Diagnostic[]; truncated: boolean; metrics: EngineMetrics }
  | { kind: 'limit'; stage: 'syntax'; resource: PrepareResource; limit: number; diagnostics: readonly Diagnostic[]; metrics: EngineMetrics };
export interface ExecutionOutput { readonly stdout: Uint8Array; readonly stderr: Uint8Array }
export type ExecuteLimitResult = LimitResult & { stage: 'execute' } & ExecutionOutput;
export type ExecuteResult = ({ kind: 'terminated'; exitCode: number; rawExitStatus: number; mainReturn: number; metrics: EngineMetrics } & ExecutionOutput) | ({ kind: 'runtime-error'; diagnostics: readonly Diagnostic[]; metrics: EngineMetrics } & ExecutionOutput) | ExecuteLimitResult;
export interface InputNeededResult extends ExecutionOutput {
  /** C is paused on an input reader; stdout/stderr are cumulative snapshots. */
  readonly kind: 'input-needed';
  readonly metrics: EngineMetrics;
}
export type ExecuteProgress = ExecuteResult | InputNeededResult;

export interface ExecutionSession {
  /** Run until termination, failure, a limit, or the next request for stdin. */
  resume(): ExecuteProgress;
  /** Append copied bytes after resume() returned input-needed. */
  appendStdin(bytes: Uint8Array): void;
  /** Close stdin; buffered bytes are consumed first and EOF remains sticky. */
  endStdin(): void;
}
