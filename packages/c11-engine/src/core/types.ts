import { HEAP_ALLOCATOR_BUILTINS } from './allocator-builtins.ts';

export interface SourceFile { readonly name: string; readonly source: string }
/** A virtual project. `files` contains translation units and headers; only names
 * listed in `translationUnits` are parsed and linked as C translation units. */
export interface SourceProject {
  readonly entry: string;
  readonly files: readonly SourceFile[];
  /** Ordered C translation units. Omitted means `[entry]`. */
  readonly translationUnits?: readonly string[];
}
export interface Diagnostic { readonly code: string; readonly message: string; readonly file: string; readonly line: number; readonly column: number }
export interface PrepareLimits { maxSourceChars: number | null; maxTokens: number | null; maxPreprocessSteps: number | null; maxDepth: number | null }
export interface ExecuteLimits { maxInstructions: number | null; maxMemoryBytes: number | null; maxIOBytes: number | null; maxDepth: number | null }
export interface PrepareOptions { limits?: Partial<PrepareLimits> }
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
export interface DebugPausedResult {
  readonly kind: 'paused';
  /** Source line of the next instruction visit, before it executes. */
  readonly location: DebugSourceLocation;
  readonly metrics: EngineMetrics;
}
export type DebugProgress = DebugPausedResult | ExecuteResult | DebugLimitResult;
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
export type DebugObjectDuration = 'automatic' | 'static' | 'heap' | 'compound-literal';
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
  /** C arithmetic type name; enum objects use their existing int-compatible representation. */
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
  readonly duration: Extract<DebugObjectDuration, 'automatic' | 'static'>;
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
/** One arithmetic cell in a bounded one-dimensional array inspection. */
export interface DebugArrayElementSnapshot {
  /** Stable within the allocation; `${rootId}:${index}`. */
  readonly key: string;
  readonly index: number;
  /** Exact virtual address in hexadecimal, without conversion through Number. */
  readonly address: string;
  readonly type: string;
  readonly initialized: boolean;
  /** Engine-formatted scalar value, or `?` when the element is indeterminate. */
  readonly displayValue: string;
  /** True when `displayValue` was shortened by `maxValueChars`. */
  readonly valueTruncated: boolean;
}
export type DebugArrayStatus = 'available' | 'too-many-elements' | 'multidimensional' | 'unsupported-element-type';
/** One observed declared array or string literal; descriptors remain visible when cells are unsupported. */
export interface DebugArraySnapshot {
  /** The real root allocation ID emitted by `object-create`. */
  readonly rootId: number;
  /** C identifier for declared arrays; string literals have no identifier. */
  readonly name?: string;
  readonly origin: Extract<DebugObjectOrigin, 'variable' | 'string-literal'>;
  readonly duration: Extract<DebugObjectDuration, 'automatic' | 'static'>;
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
export type DebugAggregateMemberUnsupportedReason = 'array' | 'aggregate';
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
  readonly type: string;
  readonly kind: DebugAggregateMemberKind;
  /** Member offset from the root, in bytes. */
  readonly offset: number;
  readonly size: number;
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
/** Read-only, bounded direct-member view of one observed aggregate allocation. */
export interface DebugAggregateSnapshot {
  /** Real root allocation identity emitted by `object-create`. */
  readonly rootId: number;
  readonly name?: string;
  readonly origin: Extract<DebugObjectOrigin, 'variable' | 'parameter'>;
  readonly duration: Extract<DebugObjectDuration, 'automatic' | 'static'>;
  readonly region: 'stack' | 'static';
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
  resume(): DebugProgress;
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
  /** Inspect bounded one-dimensional arithmetic arrays and observed string-literal characters without changing VM state. */
  inspectArrays(): DebugArrayInspection;
  /** Inspect bounded direct struct members and opaque union roots without reading C values. */
  inspectAggregates(): DebugAggregateInspection;
  /** Inspect live opaque heap allocations in ascending virtual-address order. */
  inspectHeapObjects(): readonly DebugHeapObjectSnapshot[];
}

export const ENGINE_VERSION = '0.4.0';
export const TARGET_PROFILE = Object.freeze({
  id: 'x86_64-linux-lp64' as const, endianness: 'little', charBits: 8, charSigned: true,
  boolBytes: 1, shortBits: 16, intBits: 32, intBytes: 4, intAlignment: 4,
  pointerBits: 64, pointerBytes: 8, pointerAlignment: 8, longBits: 64, longLongBits: 64, floatBits: 32, doubleBits: 64,
  integerRepresentation: 'twos-complement', signedNarrowing: 'wrap-twos-complement',
  signedRightShift: 'arithmetic', floatEvaluationMethod: 0,
});
export const CAPABILITIES = Object.freeze({
  phase: 'P4', cStandard: 'C11', completeC11: false, entry: 'int main(void), int main(), or int main(int, char **)',
  integerTypes: Object.freeze(['_Bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long']),
  floatingTypes: Object.freeze(['float', 'double']),
  pointerTypes: Object.freeze(['object-pointers', 'function-pointers', 'void-pointer-conversions', 'null-pointer-constants']),
  objectTypes: Object.freeze(['arrays', 'structs', 'unions', 'compound-literals', 'file-scope-objects']),
  enumerations: 'int-compatible-constants-with-integer-constant-expressions-in-int-range',
  aggregateMembers: Object.freeze(['named', 'anonymous-struct', 'anonymous-union']),
  operators: Object.freeze(['+', '-', '*', '/', '%', '<<', '>>', '&', '^', '|', '~', '!', '<', '<=', '>', '>=', '==', '!=', '&&', '||', '?:', ',', '=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=', '++', '--', 'cast', 'sizeof', '[]', '.', '->', '&address', 'pointer-difference']),
  statements: Object.freeze(['block', 'declaration', 'expression', 'return', 'empty', 'if', 'switch', 'while', 'do', 'for', 'break', 'continue', 'goto', 'label']),
  functions: 'typed-prototypes-variadic-functions-recursion-and-function-pointers', library: 'partial', preprocessor: 'c11-translation-phases-and-macros-with-virtual-project-includes',
  virtualHeaders: Object.freeze(['assert.h', 'ctype.h', 'errno.h', 'float.h', 'inttypes.h', 'iso646.h', 'limits.h', 'math.h', 'stdarg.h', 'stdbool.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h']),
  multipleFiles: true,
  translationUnits: true,
  standardMacros: Object.freeze(['__FILE__', '__LINE__', '__STDC__', '__STDC_VERSION__', '__STDC_HOSTED__']),
  stddefMacros: Object.freeze(['NULL']),
  stddefTypes: Object.freeze(['size_t', 'ptrdiff_t']),
  stdlibFunctions: Object.freeze([...HEAP_ALLOCATOR_BUILTINS, 'free']),
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
  stdioFunctions: Object.freeze(['printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf', 'fopen', 'fclose', 'fflush', 'fgetc', 'getc', 'getchar', 'fgets', 'fputc', 'putc', 'putchar', 'fputs', 'puts', 'fread', 'fwrite', 'fseek', 'ftell', 'rewind', 'ungetc', 'feof', 'ferror', 'clearerr', 'perror']),
  interactiveStdinFunctions: Object.freeze(['scanf', 'fscanf', 'getchar', 'getc', 'fgetc', 'fgets', 'fread']),
  debugSession: Object.freeze({
    lifecycleEvents: true, stepGranularity: 'source-line-visits', externalIO: 'discarded',
    automaticObjectPublication: 'declaration-execution',
    objectOrigins: Object.freeze(['variable', 'parameter', 'compound-literal', 'heap', 'string-literal']),
    values: Object.freeze({
      liveAutomaticScalars: true, liveStaticScalars: true, stringLiteralContents: true,
      liveHeapAllocations: true,
      oneDimensionalArithmeticArrays: 'bounded-by-debug-session-options',
      stringLiteralCharacters: 'bounded-by-debug-session-options',
      aggregates: 'bounded-direct-struct-members; unions-opaque',
      pointers: 'basic-identity-aware-binding-snapshots',
      pointerTargetResolution: 'allocation-identity-and-byte-offset-for-bounded-array-cells-and-struct-members',
    }),
    history: false, reverseExecution: false,
  }),
  stdioFormatLimitations: Object.freeze(['printf %a/%A', 'wide-character %lc/%ls', 'long-double conversions']),
  stringFunctions: Object.freeze(['memcpy', 'memmove', 'memset', 'memcmp', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp', 'strchr', 'strrchr', 'strspn', 'strcspn', 'strpbrk', 'strstr', 'strtok', 'strlen', 'strerror']),
  ctypeFunctions: Object.freeze(['isalnum', 'isalpha', 'isblank', 'iscntrl', 'isdigit', 'isgraph', 'islower', 'isprint', 'ispunct', 'isspace', 'isupper', 'isxdigit', 'tolower', 'toupper']),
  inttypesFunctions: Object.freeze(['imaxabs', 'imaxdiv', 'strtoimax', 'strtoumax']),
  mathFunctions: Object.freeze([
    ...['sqrt', 'fabs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'exp2', 'expm1', 'log', 'log2', 'log10', 'log1p', 'floor', 'ceil', 'trunc', 'round', 'cbrt', 'fmod', 'pow', 'atan2', 'hypot', 'fmin', 'fmax', 'fdim', 'copysign'].flatMap((name) => [name, `${name}f`]),
    'isnan', 'isinf', 'isfinite', 'isnormal', 'signbit', 'fpclassify',
  ]),
});
export const DEFAULT_PREPARE_LIMITS: Readonly<PrepareLimits> = Object.freeze({ maxSourceChars: 1_000_000, maxTokens: 200_000, maxPreprocessSteps: 5_000_000, maxDepth: 128 });
export const DEFAULT_EXECUTE_LIMITS: Readonly<ExecuteLimits> = Object.freeze({ maxInstructions: 1_000_000, maxMemoryBytes: 16 * 1024 * 1024, maxIOBytes: 4 * 1024 * 1024, maxDepth: 128 });
