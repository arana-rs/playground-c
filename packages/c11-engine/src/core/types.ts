import { STDIO_FUNCTIONS, STDIO_MACROS } from './stdio-metadata.ts';
import { ERRNO_MACROS } from './errno-metadata.ts';
import { STDLIB_FUNCTIONS, STDLIB_MACROS, TIME_FUNCTIONS, TIME_MACROS } from './stdlib-time-metadata.ts';
import { MATH_CLASSIFICATION_FUNCTIONS, MATH_COMPARISON_MACROS, MATH_FUNCTIONS } from './math-metadata.ts';
import { STRING_FUNCTIONS } from './string-metadata.ts';

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
export interface DebugLimitResult extends ExecutionOutput {
  readonly kind: 'debug-limit';
  readonly resource: 'maxDebugEvents';
  readonly limit: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly metrics: EngineMetrics;
}
export interface DebugPausedResult extends ExecutionOutput {
  readonly kind: 'paused';
  /** Source line of the next instruction visit, before it executes. */
  readonly location: DebugSourceLocation;
  readonly metrics: EngineMetrics;
}
export interface DebugInputNeededResult extends ExecutionOutput {
  /** Source instruction currently suspended while waiting for stdin. */
  readonly kind: 'input-needed';
  readonly location: DebugSourceLocation;
  readonly metrics: EngineMetrics;
}
export type DebugProgress = DebugPausedResult | DebugInputNeededResult | ExecuteResult | DebugLimitResult;
/** A live VM session for interactive stdin. Batch callers should use execute(). */
export interface ExecutionSession {
  /** Run until termination, failure, a limit, or the next request for stdin. */
  resume(): ExecuteProgress;
  /** Append copied bytes after resume() returned input-needed. */
  appendStdin(bytes: Uint8Array): void;
  /** Close stdin; buffered bytes are consumed first and EOF remains sticky. */
  endStdin(): void;
}

export interface DebugSourceLocation { readonly file: string; readonly line: number; readonly column: number }
export type DebugObjectDuration = 'automatic' | 'static' | 'thread-local' | 'heap' | 'compound-literal';
export type DebugObjectOrigin = 'variable' | 'parameter' | 'compound-literal' | 'heap' | 'string-literal';
interface DebugEventBase {
  readonly sequence: number;
  readonly location: DebugSourceLocation;
  readonly frameId: number | null;
  readonly scopeId: number | null;
}
export type DebugEvent =
  | (DebugEventBase & { readonly kind: 'frame-enter' | 'frame-exit'; readonly functionName: string })
  | (DebugEventBase & { readonly kind: 'scope-enter' | 'scope-exit'; readonly functionName: string; readonly scopeName: string })
  | (DebugEventBase & {
    readonly kind: 'object-create' | 'object-delete';
    readonly objectId: number;
    readonly allocationId: number;
    readonly duration: DebugObjectDuration;
    readonly origin: DebugObjectOrigin;
    readonly name?: string;
    readonly typeSummary: string;
    readonly addressVirtual: bigint;
    readonly size: number;
  });
/** Read-only value snapshot for a live automatic arithmetic scalar in a debug session. */
export interface DebugScalarSnapshot {
  /** Same allocation identity emitted by the object's `object-create` event. */
  readonly id: number;
  readonly scopeId: number;
  readonly frameId: number;
  readonly name: string;
  /** Storage origin shared with the corresponding object lifecycle event. */
  readonly origin: DebugObjectOrigin;
  /** C arithmetic type name, retaining qualifiers; enum objects use their int-compatible representation. */
  readonly type: string;
  /** Exact virtual address in hexadecimal, without conversion through Number. */
  readonly address: string;
  readonly size: number;
  readonly initialized: boolean;
  /** Full engine-formatted value, or `?` for an uninitialized object. */
  readonly displayValue: string;
}
/** Lifetime/representation state for a pointer value visible to a debug snapshot. */
export type DebugPointerStatus = 'uninitialized' | 'null' | 'live' | 'one-past' | 'dangling' | 'unmapped' | 'function';
/** Identity metadata for an object pointer; this never includes the pointed-to value. */
export interface DebugPointerTargetSnapshot {
  /** Allocation identity from the target's real object-create event. */
  readonly allocationId: number;
  /** Byte offset within that allocation. */
  readonly byteOffset: number;
  /** C type designated by the pointer expression. */
  readonly type: string;
  /** Root binding name, included only when identity and type match at byte offset zero. */
  readonly name?: string;
}
/** Read-only snapshot of a live automatic or observed static pointer object. */
export interface DebugPointerSnapshot {
  /** Allocation identity of the pointer variable itself. */
  readonly id: number;
  readonly scopeId: number | null;
  readonly frameId: number | null;
  readonly name: string;
  readonly origin: Extract<DebugObjectOrigin, 'variable' | 'parameter'>;
  readonly duration: Extract<DebugObjectDuration, 'automatic' | 'static' | 'thread-local'>;
  readonly region: 'stack' | 'static';
  readonly type: string;
  /** Address of the pointer variable's own storage. */
  readonly address: string;
  readonly size: number;
  readonly initialized: boolean;
  /** Exact stored pointer representation in hexadecimal, or `?` when indeterminate. */
  readonly displayValue: string;
  readonly status: DebugPointerStatus;
  /** Object identity metadata only; never follows or reads the destination. */
  readonly target?: DebugPointerTargetSnapshot;
}
/** Read-only values for static-duration arithmetic objects and string literals observed in a debug session. */
export interface DebugStaticObjectSnapshot {
  /** Same allocation identity emitted by the object's `object-create` event. */
  readonly id: number;
  /** C identifier for variables; string literals have no identifier. */
  readonly name?: string;
  /** Existing lifecycle origin; this inspection publishes only variables and string literals. */
  readonly origin: Extract<DebugObjectOrigin, 'variable' | 'string-literal'>;
  /** Thread-local objects are represented in the session's static region without simulating other threads. */
  readonly duration: Extract<DebugObjectDuration, 'static' | 'thread-local'>;
  /** Arithmetic C type, or `char[N]` for the contents of a string literal. */
  readonly type: string;
  /** Exact virtual address in hexadecimal, without conversion through Number. */
  readonly address: string;
  readonly size: number;
  readonly initialized: boolean;
  /** Full engine-formatted scalar or C-escaped string literal, or `?` if indeterminate. */
  readonly displayValue: string;
}
/** Controls which observed static objects are included by the legacy static inspector. */
export interface DebugStaticObjectInspectionOptions {
  /** Include full C-escaped string-literal previews; defaults to true for compatibility. */
  readonly includeStringLiterals?: boolean;
}
/** Shared data for one cell in a bounded one-dimensional array inspection. */
interface DebugArrayElementSnapshotBase {
  /** Stable within the allocation; `${rootId}:${index}`. */
  readonly key: string;
  readonly index: number;
  /** Exact virtual address in hexadecimal, without conversion through Number. */
  readonly address: string;
  readonly type: string;
  readonly initialized: boolean;
  /** Engine-formatted scalar or pointer value, or `?` when the element is indeterminate. */
  readonly displayValue: string;
  /** True when an arithmetic value was shortened by `maxValueChars`; pointer addresses are never truncated. */
  readonly valueTruncated: boolean;
}
/** One arithmetic cell or pointer value in a bounded one-dimensional array inspection. */
export type DebugArrayElementSnapshot = DebugArrayElementSnapshotBase & (
  | {
    /** Omitted on arithmetic cells to preserve their existing serialized shape. */
    readonly kind?: undefined;
    readonly pointerStatus?: undefined;
    readonly target?: undefined;
  }
  | {
    readonly kind: 'pointer';
    /** Pointer state and destination identity reuse the scalar pointer inspector's semantics. */
    readonly pointerStatus: DebugPointerStatus;
    /** Direct destination identity only; the inspector never follows or reads it. */
    readonly target?: DebugPointerTargetSnapshot;
  }
);
export type DebugArrayStatus = 'available' | 'too-many-elements' | 'multidimensional' | 'unsupported-element-type';
/** One observed declared array or string literal; descriptors remain visible when cells are unsupported. */
export interface DebugArraySnapshot {
  /** The real root allocation ID emitted by `object-create`. */
  readonly rootId: number;
  /** C identifier for declared arrays; string literals have no identifier. */
  readonly name?: string;
  readonly origin: Extract<DebugObjectOrigin, 'variable' | 'string-literal'>;
  readonly duration: Extract<DebugObjectDuration, 'automatic' | 'static' | 'thread-local'>;
  readonly region: 'stack' | 'static';
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly type: string;
  readonly elementType: string;
  /** Exact virtual root address in hexadecimal. */
  readonly address: string;
  readonly size: number;
  readonly length: number;
  readonly readOnly: boolean;
  readonly status: DebugArrayStatus;
  readonly elements: readonly DebugArrayElementSnapshot[];
}
/** Bounded array inspection result; `omittedObjects` counts only roots omitted by `maxObjects`. */
export interface DebugArrayInspection {
  readonly arrays: readonly DebugArraySnapshot[];
  readonly omittedObjects: number;
}
/** Why a direct struct member is represented as a bounded placeholder. */
export type DebugAggregateMemberUnsupportedReason = 'array' | 'aggregate' | 'flexible-array';
/** The value form published for one supported direct struct member. */
export type DebugAggregateMemberKind = 'arithmetic' | 'pointer' | 'unsupported';
/** Direct-member inspection state for a live observed struct/union root. */
export type DebugAggregateStatus = 'available' | 'unsupported-union' | 'too-many-members';
/** One exact byte range of padding in a struct object. */
export interface DebugAggregatePaddingSnapshot {
  /** Stable within the root allocation; `${rootId}:padding:${offset}`. */
  readonly key: string;
  readonly offset: number;
  readonly size: number;
}
/** One direct member of a struct root, or a local placeholder for an unsupported member type. */
export interface DebugAggregateMemberSnapshot {
  /** Stable within the root allocation; `${rootId}:${index}`. */
  readonly key: string;
  readonly index: number;
  /** Empty for an anonymous direct aggregate member. */
  readonly name: string;
  /** C type name, retaining qualifiers without exposing the internal compiler type. */
  readonly type: string;
  readonly kind: DebugAggregateMemberKind;
  /** Member offset from the root, in bytes; for bit-fields this is the storage-unit offset. */
  readonly offset: number;
  /** Storage extent in bytes; for bit-fields this is the shared allocation unit. */
  readonly size: number;
  /** Present for a named bit-field; unnamed padding fields are not exposed. */
  readonly bitWidth?: number;
  /** Least-significant bit position within the storage unit. */
  readonly bitOffset?: number;
  /** Byte width of the storage unit shared by this bit-field. */
  readonly storageUnitSize?: number;
  /** Runtime extent of a flexible array member when the containing object provides one. */
  readonly flexibleArray?: DebugFlexibleArraySnapshot;
  /** Exact virtual address of this member. */
  readonly address: string;
  /** Null for a placeholder; false for an indeterminate arithmetic/pointer member. */
  readonly initialized: boolean | null;
  /** Full engine-formatted arithmetic value or pointer address; null for a placeholder. */
  readonly displayValue: string | null;
  readonly pointerStatus?: DebugPointerStatus;
  /** Identity only; the inspector never reads or follows the target. */
  readonly target?: DebugPointerTargetSnapshot;
  readonly unsupportedReason?: DebugAggregateMemberUnsupportedReason;
}
/** Runtime extent for one flexible array member in an observed aggregate object. */
export interface DebugFlexibleArraySnapshot {
  readonly elementSize: number;
  readonly capacityBytes: number;
  readonly length: number;
  /** Same bounded-cell result used by ordinary one-dimensional array inspection. */
  readonly status: DebugArrayStatus;
  readonly elements: readonly DebugArrayElementSnapshot[];
  /** Number of elements beyond the published prefix. */
  readonly omittedElements: number;
}
/** Read-only, bounded direct-member view of one observed aggregate allocation. */
export interface DebugAggregateSnapshot {
  /** Real root allocation identity emitted by `object-create`. */
  readonly rootId: number;
  /** Distinguishes typed subobject views that share one heap allocation; omitted when identical to `rootId`. */
  readonly viewId?: number;
  readonly name?: string;
  readonly origin: Extract<DebugObjectOrigin, 'variable' | 'parameter' | 'heap'>;
  readonly duration: Extract<DebugObjectDuration, 'automatic' | 'static' | 'thread-local' | 'heap'>;
  readonly region: 'stack' | 'static' | 'heap';
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly type: string;
  readonly kind: 'struct' | 'union';
  readonly address: string;
  readonly size: number;
  readonly readOnly: boolean;
  readonly memberCount: number;
  readonly status: DebugAggregateStatus;
  readonly members: readonly DebugAggregateMemberSnapshot[];
  readonly padding: readonly DebugAggregatePaddingSnapshot[];
}
/** Bounded observed aggregate roots; omissions count only roots over `maxObjects`. */
export interface DebugAggregateInspection {
  readonly aggregates: readonly DebugAggregateSnapshot[];
  readonly omittedObjects: number;
}
/** Hard cap for direct struct members published by the aggregate inspector. */
export const DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS = Object.freeze({ maxMembers: 10 });
/** Safe core fallbacks; hosts may pass their RUN_CONFIGURATION budgets explicitly. */
export const DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS = Object.freeze({
  maxObjects: 1_000,
  maxElementsPerArray: 10,
  maxValueChars: 256,
});
/** Reserved x86-64 LP64 virtual address ranges for session objects. Ends are exclusive. */
export const VIRTUAL_MEMORY_LAYOUT = Object.freeze({
  alignmentBytes: 16,
  guardBytes: 16,
  staticAddressRange: Object.freeze({ start: 0x0001_0000n, endExclusive: 0x0002_0000n }),
  stackAddressRange: Object.freeze({ start: 0x0002_0000n, endExclusive: 0x0003_0000n }),
  heapAddressRange: Object.freeze({ start: 0x0003_0000n, endExclusive: 0x0004_0000n }),
});
/** Backwards-compatible heap-only layout; values derive from the shared memory layout. */
export const VIRTUAL_HEAP_LAYOUT = Object.freeze({
  ...VIRTUAL_MEMORY_LAYOUT.heapAddressRange,
  alignmentBytes: VIRTUAL_MEMORY_LAYOUT.alignmentBytes,
});
/** Live raw malloc blocks; opaque blocks have identity, address and extent only. */
export interface DebugHeapObjectSnapshot {
  /** Same allocation identity emitted by the object's `object-create` event. */
  readonly id: number;
  /** Exact virtual address in hexadecimal, without conversion through Number. */
  readonly address: string;
  readonly size: number;
  readonly origin: 'heap';
}
export interface DebugSessionOptions {
  /** Total number of lifecycle events the session may emit. Defaults to 100,000. */
  readonly maxEvents?: number;
  /** Reproducible non-cryptographic heap address placement for debug/testing. */
  readonly heapAddressSeed?: number;
  /** Maximum observed array or aggregate roots returned by each inspector; defaults to 1,000. */
  readonly maxObjects?: number;
  /** Maximum cells inspected per array; defaults to 10. Includes string terminators and zero-filled cells. */
  readonly maxElementsPerArray?: number;
  /** Maximum characters in each array cell's formatted value; defaults to 256. */
  readonly maxValueChars?: number;
}
export interface DebugExecutionSession {
  /** Run one source-line visit, or continue a suspended visit until its next pause. */
  resume(): DebugProgress;
  /** Append copied bytes after resume() returned input-needed. */
  appendStdin(bytes: Uint8Array): void;
  /** Close stdin; buffered bytes are consumed first and EOF remains sticky. */
  endStdin(): void;
  /** Location of the next source instruction visit, or null after termination/setup failure. */
  currentLocation(): DebugSourceLocation | null;
  /** Return events produced since the previous drain, in sequence order. */
  drainEvents(): readonly DebugEvent[];
  /** Inspect live automatic arithmetic scalars without reading or changing VM state. */
  inspectScalars(): readonly DebugScalarSnapshot[];
  /** Inspect live automatic, parameter, and observed static pointer objects without reading their destinations. */
  inspectPointers(): readonly DebugPointerSnapshot[];
  /** Inspect observed static arithmetic objects and string literals without reading or changing VM state. */
  inspectStaticObjects(options?: DebugStaticObjectInspectionOptions): readonly DebugStaticObjectSnapshot[];
  /** Inspect bounded one-dimensional arithmetic or pointer arrays and observed string-literal characters without changing VM state. */
  inspectArrays(): DebugArrayInspection;
  /** Inspect bounded direct struct members and opaque union roots without reading C values. */
  inspectAggregates(): DebugAggregateInspection;
  /** Inspect live opaque heap allocations in ascending virtual-address order. */
  inspectHeapObjects(): readonly DebugHeapObjectSnapshot[];
}

export const ENGINE_VERSION = '0.1.0';
export const TARGET_PROFILE = Object.freeze({
  id: 'x86_64-linux-lp64' as const, endianness: 'little', charBits: 8, charSigned: true,
  boolBytes: 1, shortBits: 16, intBits: 32, intBytes: 4, intAlignment: 4,
  pointerBits: 64, pointerBytes: 8, pointerAlignment: 8, longBits: 64, longLongBits: 64,
  floatBits: 32, doubleBits: 64,
  longDoubleBits: 80, longDoubleStorageBytes: 16, longDoubleAlignment: 16,
  longDoubleSignificandBits: 64, longDoubleExponentBits: 15, longDoubleRepresentation: 'x87-binary80',
  integerRepresentation: 'twos-complement', signedNarrowing: 'wrap-twos-complement',
  signedRightShift: 'arithmetic', floatEvaluationMethod: 0,
});
export const CAPABILITIES = Object.freeze({
  phase: 'P6', cStandard: 'C11', completeC11: false, entry: 'int main(void), int main(), or int main(int, char **)',
  integerTypes: Object.freeze(['_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long']),
  floatingTypes: Object.freeze(['float', 'double', 'long double']),
  pointerTypes: Object.freeze(['object-pointers', 'function-pointers', 'void-pointer-conversions', 'null-pointer-constants']),
  objectTypes: Object.freeze(['arrays', 'structs', 'unions', 'compound-literals', 'file-scope-objects']),
  stringLiteralProfile: 'char-arrays-with-terminator; narrow-UCNs-encode-as-UTF-8; u8-raw-Unicode-and-UCNs-encode-as-UTF-8; ordinary-raw-non-ASCII-and-wide-literal-prefixes-unsupported',
  characterConstantProfile: 'single-byte-values-use-signed-char-profile; multicharacter-bytes-pack-left-to-right-into-int-low-32-bits',
  variableLengthArrays: 'captured-runtime-bounds; dynamic-sizeof-for-array-operands-and-type-names; nested-dimensions; typedefs; adjusted-parameters; pointer-to-VLA-strides; scoped-lifetimes',
  enumerations: 'distinct-enum-types-with-int-compatible-representation-int-promotions-int-enumerators-and-integer-constant-expressions-in-int-range',
  aggregateMembers: Object.freeze(['named', 'anonymous-struct', 'anonymous-union', 'bit-fields', 'flexible-array-members']),
  qualifiers: Object.freeze(['const', 'volatile', 'restrict']),
  restrictProfile: 'observed dynamic diagnostics cover independent restrict bases and modified restrict/plain overlaps across typed, byte-wise and library accesses; same-chain derivations, common pointer/integer round-trips, read-only/no-access cases, disjoint subobjects and distinct bit-fields are accepted; arbitrary integer transformations and values parsed from library text can have unresolved provenance, producing RESTRICT_PROVENANCE_UNKNOWN only after an observed modified overlap',
  operators: Object.freeze(['+', '-', '*', '/', '%', '<<', '>>', '&', '^', '|', '~', '!', '<', '<=', '>', '>=', '==', '!=', '&&', '||', '?:', ',', '=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=', '++', '--', 'cast', 'sizeof', '[]', '.', '->', '&address', 'pointer-difference', '_Generic', '_Alignas', '_Alignof', '_Static_assert', 'offsetof']),
  statements: Object.freeze(['block', 'declaration', 'expression', 'return', 'empty', 'if', 'switch', 'while', 'do', 'for', 'break', 'continue', 'goto', 'label', 'static-assert']),
  genericSelection: true,
  staticAssertions: true,
  storageClasses: Object.freeze(['auto', 'extern', 'register', 'static', '_Thread_local', 'typedef']),
  storageDurations: Object.freeze(['automatic', 'static', 'allocated', 'thread-local']),
  linkage: Object.freeze(['external', 'internal', 'no-linkage']),
  blockExternDeclarations: true,
  externalInlineSemantics: 'c11',
  functions: 'typed-prototypes-variadic-functions-recursion-and-function-pointers', library: 'partial', preprocessor: 'c11-translation-phases-and-macros-with-virtual-project-includes',
  syntaxAnalysis: 'preprocess-and-parse-without-linking-or-execution; up-to-20-parser-diagnostics-with-boundary-recovery; safe-token-ranges-and-related-delimiter-locations',
  virtualHeaders: Object.freeze(['assert.h', 'ctype.h', 'errno.h', 'float.h', 'inttypes.h', 'iso646.h', 'limits.h', 'math.h', 'stdarg.h', 'stdalign.h', 'stdbool.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h', 'time.h']),
  multipleFiles: true,
  translationUnits: true,
  standardMacros: Object.freeze(['__FILE__', '__LINE__', '__STDC__', '__STDC_VERSION__', '__STDC_HOSTED__']),
  stdalignMacros: Object.freeze(['alignas', 'alignof', '__alignas_is_defined', '__alignof_is_defined']),
  stddefMacros: Object.freeze(['NULL', 'offsetof']),
  stddefTypes: Object.freeze(['size_t', 'ptrdiff_t', 'max_align_t']),
  errnoMacros: Object.freeze(Object.keys(ERRNO_MACROS)),
  stdlibFunctions: STDLIB_FUNCTIONS,
  stdlibMacros: STDLIB_MACROS,
  stdlibProfile: 'C locale; MB_CUR_MAX=1; virtual environment is empty; system(NULL)=0 and system(nonnull) returns ENOSYS; rand is deterministic per execution',
  timeFunctions: TIME_FUNCTIONS,
  timeMacros: TIME_MACROS,
  timeProfile: 'UTC only; deterministic core default with optional per-call host wall clock; localtime equals gmtime; clock ticks are VM instructions × 1000',
  preparedProgram: Object.freeze({ heapAllocationHint: 'hasHeapAllocationCalls: resolved built-in calls across all function bodies' }),
  virtualMemory: Object.freeze({
    alignmentBytes: VIRTUAL_MEMORY_LAYOUT.alignmentBytes,
    guardBytes: VIRTUAL_MEMORY_LAYOUT.guardBytes,
    staticAddressRange: Object.freeze({
      start: `0x${VIRTUAL_MEMORY_LAYOUT.staticAddressRange.start.toString(16)}`,
      endExclusive: `0x${VIRTUAL_MEMORY_LAYOUT.staticAddressRange.endExclusive.toString(16)}`,
      capacityBytes: Number(VIRTUAL_MEMORY_LAYOUT.staticAddressRange.endExclusive - VIRTUAL_MEMORY_LAYOUT.staticAddressRange.start),
      allocationPolicy: 'first-fit-persistent',
    }),
    stackAddressRange: Object.freeze({
      start: `0x${VIRTUAL_MEMORY_LAYOUT.stackAddressRange.start.toString(16)}`,
      endExclusive: `0x${VIRTUAL_MEMORY_LAYOUT.stackAddressRange.endExclusive.toString(16)}`,
      capacityBytes: Number(VIRTUAL_MEMORY_LAYOUT.stackAddressRange.endExclusive - VIRTUAL_MEMORY_LAYOUT.stackAddressRange.start),
      allocationPolicy: 'ordered-first-fit-reuse-on-scope-exit',
    }),
    heapAddressRange: Object.freeze({
      start: `0x${VIRTUAL_HEAP_LAYOUT.start.toString(16)}`,
      endExclusive: `0x${VIRTUAL_HEAP_LAYOUT.endExclusive.toString(16)}`,
      capacityBytes: Number(VIRTUAL_HEAP_LAYOUT.endExclusive - VIRTUAL_HEAP_LAYOUT.start),
      alignmentBytes: VIRTUAL_HEAP_LAYOUT.alignmentBytes,
      guardBytes: VIRTUAL_MEMORY_LAYOUT.guardBytes,
      randomization: 'non-cryptographic per allocation',
    }),
  }),
  stdioFunctions: STDIO_FUNCTIONS,
  stdioMacros: STDIO_MACROS,
  stdioBufferingProfile: 'default-_IONBF-immediate-output; setvbuf-supports-_IOFBF-_IOLBF-_IONBF-before-stream-operation; buffered-modes-require-positive-representable-capacity; caller-buffer-range-validated-but-engine-owns-internal-queue; setbuf-nonnull-selects-_IOFBF-and-null-selects-_IONBF; flush-on-capacity-newline-before-stdin-read-fflush-close-reposition-and-normal-return-or-exit-after-atexit; quick_exit-_Exit-abort-runtime-errors-and-cancellation-do-not-auto-flush',
  stdioFileProfile: 'virtual files only; tmpfile is deleted on close or termination; tmpnam uses a per-execution reusable buffer; fpos_t is long byte offset',
  interactiveStdinFunctions: Object.freeze(['scanf', 'fscanf', 'getchar', 'getc', 'fgetc', 'fgets', 'fread']),
  debugSession: Object.freeze({
    lifecycleEvents: true, stepGranularity: 'source-line-visits', externalIO: 'virtual-stdio',
    interactiveStdin: true, outputSnapshots: 'cumulative-per-progress',
    automaticObjectPublication: 'declaration-execution',
    objectOrigins: Object.freeze(['variable', 'parameter', 'compound-literal', 'heap', 'string-literal']),
    values: Object.freeze({
      liveAutomaticScalars: true, liveStaticScalars: true, stringLiteralContents: true,
      liveHeapAllocations: true,
      oneDimensionalArithmeticArrays: 'bounded-by-debug-session-options',
      oneDimensionalPointerArrays: 'bounded-by-debug-session-options-and-default-array-cell-maximum; direct-pointer-status-and-target-identity',
      stringLiteralCharacters: 'bounded-by-debug-session-options',
      aggregates: 'bounded-direct-struct-members; unions-opaque',
      pointers: 'basic-identity-aware-binding-snapshots',
      pointerTargetResolution: 'allocation-identity-and-byte-offset-for-bounded-array-cells-and-struct-members',
    }),
    history: false, reverseExecution: false,
  }),
  stdioFormatLimitations: Object.freeze(['printf hexadecimal precision cap: 100000 digits']),
  stringFunctions: STRING_FUNCTIONS,
  ctypeFunctions: Object.freeze(['isalnum', 'isalpha', 'isblank', 'iscntrl', 'isdigit', 'isgraph', 'islower', 'isprint', 'ispunct', 'isspace', 'isupper', 'isxdigit', 'tolower', 'toupper']),
  inttypesFunctions: Object.freeze(['imaxabs', 'imaxdiv', 'strtoimax', 'strtoumax']),
  mathFunctions: MATH_FUNCTIONS,
  mathClassificationMacros: MATH_CLASSIFICATION_FUNCTIONS,
  mathComparisonMacros: MATH_COMPARISON_MACROS,
  mathTypes: Object.freeze(['float_t', 'double_t']),
  mathConstants: Object.freeze([
    'INFINITY', 'HUGE_VAL', 'HUGE_VALF', 'HUGE_VALL', 'NAN', 'FP_NAN', 'FP_INFINITE',
    'FP_ZERO', 'FP_SUBNORMAL', 'FP_NORMAL', 'FP_ILOGB0', 'FP_ILOGBNAN',
    'MATH_ERRNO', 'MATH_ERREXCEPT', 'math_errhandling',
  ]),
  mathErrorHandling: 'MATH_ERRNO-only; domain errors set EDOM; pole and range errors set ERANGE; floating-point exception flags are not exposed',
});
export const DEFAULT_PREPARE_LIMITS: Readonly<PrepareLimits> = Object.freeze({ maxSourceChars: 1_000_000, maxTokens: 200_000, maxPreprocessSteps: 5_000_000, maxDepth: 128 });
export const DEFAULT_EXECUTE_LIMITS: Readonly<ExecuteLimits> = Object.freeze({ maxInstructions: 1_000_000, maxMemoryBytes: 16 * 1024 * 1024, maxIOBytes: 4 * 1024 * 1024, maxDepth: 128 });
