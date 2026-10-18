# @playground/c11-engine · P5 and P6 implemented in the agreed profile · 0.1.0

An incremental C engine for browsers and Node.js, targeting the x86-64 Linux LP64 profile. It interprets C in its own virtual machine; it does not compile or execute native instructions. The core does not depend on React, DOM, Worker, File, or the filesystem. The package **does not implement all of C11**: `CAPABILITIES` publishes the profile, and an out-of-scope capability produces an explicit diagnostic.

## Coverage in this version

P4 retains the numeric, control-flow, object, and memory capabilities from P1–P3. It adds C translation with object-like, function-like, and variadic macros; `#` and `##`; `#undef`, conditionals, includes from virtual files, trigraphs, line splicing, UCNs, and literal concatenation. Stringification preserves preprocessing-token spelling, including a UCN such as `\u00E9`, while normalizing whitespace and escaping quotes and backslashes. Diagnostics retain their file and line after `#line` and includes. `#error`, STDC pragmas, and the predefined macros listed in `CAPABILITIES` are supported. The feature-test macros `__STDC_NO_COMPLEX__`, `__STDC_NO_ATOMICS__`, and `__STDC_NO_THREADS__` are defined as `1`, indicating that these features are unsupported in this profile. `__STDC_NO_VLA__` is not defined while the profile implements VLA support; C11 defines no `__STDC_NO_IMAGINARY__` macro.

String literals are narrow `char` arrays with a terminating NUL. UCNs in ordinary narrow strings produce UTF-8 bytes; `u8` strings also encode raw Unicode source characters as UTF-8. String-literal array initialization accepts `char` and qualified `char` element types; an inferred bound includes the terminating NUL, while an explicit bound may omit it when the source characters fit. Raw non-ASCII source characters in unprefixed strings and wide literal prefixes are unsupported. A one-byte character constant follows the signed-`char` profile, so `'\xFF'` has value `-1`. Multi-character constants pack their bytes from left to right into `int`, retaining the low 32 bits: `'ab'` is `0x6162`, and `'abcde'` is `0x62636465`. `CAPABILITIES.stringLiteralProfile` and `CAPABILITIES.characterConstantProfile` publish these choices.

P5 implements the agreed scope across nine language areas: bit-fields/padding and flexible members; the `const`, `volatile`, and `restrict` qualifiers; `_Generic` selection; `_Alignas`, `_Alignof`, `_Static_assert`, `stdalign.h`, `offsetof`, and `max_align_t`; storage/linkage, block-scope `extern`, C11 `inline` semantics, and single-thread `_Thread_local`; declarator/typedef composition; promotions, conversions, and function arguments; duration, representation, and effective type. This scope is complete within the published profile. `CAPABILITIES.phase` identifies the current phase; `completeC11: false` means that the profile does not cover all of C11 and does not indicate whether P5 is complete.

Here, “partial” describes coverage of complete C11 feature families. The P5 scope is the finite profile described and tested in the sections below; the APIs published in `CAPABILITIES.stdioFunctions`, `stdlibFunctions`, and `timeFunctions` are implemented. Capabilities outside those sets are identified as profile limits, part of P6, or `Unplanned`. This audit found no additional concrete gaps in the published APIs or in the P5 declarator and scope cases. P5 is therefore implemented within the agreed profile, even though C11 and the standard-library families remain partial.

### P6: Implemented in the Agreed Profile

P6 covers runtime `sizeof` for variable-length arrays and the real-valued C11 `math.h` API for `float`, `double`, and `long double`. This includes the function families, integer-returning and output-parameter functions, `nexttoward` mixed-format parameters, `float_t`/`double_t`, classification and comparison macros, and the required constants. The header reports `math_errhandling == MATH_ERRNO`; domain errors set `EDOM`, pole and range errors set `ERANGE`, and successful calls preserve `errno`. C11 leaves whether underflow sets `errno` to the implementation; this profile preserves it for exact zero and subnormal results and does not claim Annex F underflow behavior. Floating-point exception flags remain outside this profile with `<fenv.h>` listed as `Unplanned`. VLA fixtures cover nested dimensions, VLA type names and typedefs, pointer-to-VLA stride and operand effects, adjusted array parameters, and inspection of an active VLA's extent. Math fixtures cover result types, output parameters, comparison macro evaluation, binary80 values outside binary64 range, exact subnormals, domain/pole/range reporting, and fused multiply-add cases that distinguish one final rounding from intermediate rounding. GCC and Clang differential checks are part of the P6 suite.

The VLA subset retains C11 constraints on integer bounds, positive run-time lengths, block/prototype scope, linkage, storage duration, and initialization; VLA array objects cannot have static or thread storage duration, while pointers to VLA types may have static storage duration. It does not claim complete L34 support. The real-valued math functions and macros published by `CAPABILITIES` cover the C11 `math.h` API for this profile; complex functions and type-generic dispatch through `<tgmath.h>` remain outside it. `math_errhandling` selects `MATH_ERRNO`; `<fenv.h>` and floating-point exception flags remain `Unplanned`. `fma`/`fmaf`/`fmal` compute the exact ternary result before one rounding to the result type. Other `long double` math results preserve binary80, but the profile does not promise correct rounding for every input or Annex F conformance.

### Partial scope of L07 and L11

Declaration and conversion coverage is defined by this finite regression matrix; it does not claim to cover every C11 declaration or conversion.

| Area | Included cases | Published limit |
| --- | --- | --- |
| L07 · declarators and types | Tested composition of pointer, array, function, and function-pointer declarators; `typedef` aliases; incomplete arrays completed by an initializer; adjustment of array/function parameters to pointers; composite types for array and function declarations, including across translation units; rejection of incompatible types. | Completeness is checked by context: permitted declarations may retain incomplete types, while value uses that require completeness are diagnosed. Visibility covers the separate tag and ordinary identifier namespaces, typedef hiding, `for` scope, parameters, and prototype-scope tags. This does not claim to complete the entire grammar or every L07 diagnostic. |
| L11 · promotions and conversions | Promotions of `_Bool`, small integer types, and enums to `int` in this profile; `float` to `double` in variadic or unprototyped calls; conversion of arguments to prototype parameters; signed and unsigned integer conversions under LP64; compatibility between prototypes and unprototyped declarations under the default promotions. | `f()` retains the meaning of a declaration with no parameter list, while `f(void)` declares zero parameters. The profile chooses `int` as the compatible integer type for enums; enumerators are `int` constants, but sharing that compatible type does not make distinct enum types compatible with each other. These rules do not complete L11 or imply universal detection of undefined behavior. |

Array, function, pointer, alias, and compatibility limits are tested in `tests/p5-language.test.mjs`, `tests/p5-language-extension.test.mjs`, and `tests/p5-differential.test.mjs`. Typedef visibility and enums have dedicated regressions in `tests/p5-language.test.mjs` and `tests/p5-enum-types.test.mjs`. Differential oracles use GCC and Clang with `-std=c11 -pedantic-errors` for defined programs within the profile.

The P5 library expansion adds the narrow APIs declared in `<stdio.h>`, the subset of `<stdlib.h>` published in `CAPABILITIES.stdlibFunctions`, and ten `<time.h>` functions. Files and temporary files remain in the virtual filesystem; `freopen` preserves `FILE *` identity. In this profile, `freopen(NULL, mode, stream)` closes the previous stream, returns `NULL`, and sets `EINVAL` without selecting a new configuration. This is the option C11 permits when `filename` is null. `tmpfile` is removed when closed or when execution ends, and `fpos_t` is `long` with byte offsets. Streams default to `_IONBF`, preserving immediate output. `setvbuf` supports `_IOFBF`, `_IOLBF`, and `_IONBF` before any operation on the stream; buffered modes require a positive representable capacity. A non-null caller buffer is validated for a writable range, while the engine owns the actual pending-byte queue. `setbuf(NULL)` selects `_IONBF`, and a non-null buffer selects `_IOFBF` with `BUFSIZ` capacity. Full buffers flush at capacity; line-buffered streams also flush on newline and before a stdin read. `fflush`, close, repositioning, normal return, and `exit` after `atexit` handlers flush pending output. `quick_exit`, `_Exit`, `abort`, runtime errors, and cancellation do not automatically flush. The wide conversions `%lc`, `%ls`, and `%l[` remain explicitly rejected.

The bit-field profile is compared with GCC and Clang for the SysV x86-64 ABI. Plain `int` signedness, bit order, shared units, and zero-width barriers are profile choices, not universal C11 guarantees. Flexible members occupy the tail of an allocation, do not increase `sizeof`, and struct assignment copies only the fixed portion. Explicit alignments accept powers of two up to 65536 bytes; `malloc` provides 16-byte alignment. `max_align_t` has size 32 and alignment 16 on this target. TLS distinguishes storage duration and retains a single instance per session, with no concurrency model. Pointer-to-`uintptr_t` casts preserve known live virtual addresses according to the profile. `volatile` preserves its evaluations in the abstract machine. The dynamic `restrict` checker observes typed, byte-wise, and library accesses, including the exact ranges consumed by bounded string operations. It permits same-chain derivations and common pointer/integer round-trips, read-only access, no access, disjoint subobjects, and distinct bit-fields sharing a storage unit. Arbitrary integer transformations and integer values reconstructed from library text may lose tracked provenance. In that case, `RESTRICT_PROVENANCE_UNKNOWN` reports uncertainty only after an observed overlap with a restrict-based access and at least one modification; it does not assert a confirmed C violation. A known independent-base violation reports `RESTRICT_ALIAS`. The checker is dynamic and does not claim to detect every aliasing violation or all undefined behavior.

A project can have multiple translation units. Each unit is prepared with its own macro state, and the units are linked before execution. File-scope linkage (`static`), `extern`, `inline` functions, and K&R definitions are supported within the tested profile. External and tentative definitions are validated across units; object and macro state is not shared between units as though preprocessor state were global.

Variadic functions support the default promotions and `va_start`, `va_arg`, `va_copy`, and `va_end`. `main` supports `int main(void)`, parameterless `int main()`, and `int main(int, char **)`; the `argv` vector is complete, ends with a null pointer, and is configured per execution.

The 17 headers listed in `CAPABILITIES.virtualHeaders` are built-in virtual C sources, not copies from the host. Their coverage is partial. Tested subsets include `assert.h`, `ctype.h`, `errno.h`, `inttypes.h`, `iso646.h`, `stdarg.h`, `stdalign.h`, `stdio.h`, `stdlib.h`, `string.h`, and `time.h`, along with the numeric headers and `stddef.h`. `<stdalign.h>` defines `alignas`/`alignof` and the `__alignas_is_defined`/`__alignof_is_defined` macros; `<stddef.h>` provides `size_t`, `ptrdiff_t`, `offsetof`, and `max_align_t` as defined by the profile.

Narrow `<stdio.h>` coverage includes the 45 functions in `CAPABILITIES.stdioFunctions`: the `v*` families, virtual and temporary files, `freopen`, profile-specific buffering and `fgetpos`/`fsetpos` positions, as well as streams, EOF/error handling, binary input, and formatting. `scanf` floating conversions and `strtof`/`strtod` share direct target-format conversion for binary32/binary64; decimal inputs round to the nearest representable value with ties to even, and hexadecimal inputs convert from their exact rational value. `scanf` `%Lf` and `strtold` retain binary80 conversion. `printf` supports `%a`/`%A` for `double` and `long double`, and its decimal `%f`/`%e`/`%g` formatting uses exact rational rounding. Decimal precision is bounded by the existing `maxIOBytes` output budget and `maxInstructions` work budget, with no separate decimal precision cap; `%a`/`%A` retain a maximum precision of 100000 hexadecimal digits, as recorded in `CAPABILITIES.stdioFormatLimitations`. The wide conversions `%lc`, `%ls`, and `%l[` produce an explicit diagnostic and are outside the plan. `<stdlib.h>` provides narrow numeric conversions, allocation, search/sort, deterministic RNG, an empty virtual environment, and termination through the C scheduler; `system(NULL)` returns zero, and `system` with a command fails with `ENOSYS`. `<time.h>` uses UTC and retains the fixed instant `2024-01-01T00:00:00Z` when the core runs without host services; Run and Memory Viewer inject the Worker's actual clock. `time()` returns seconds, `timespec_get()` derives nanoseconds at millisecond resolution in those Workers, and `localtime` matches `gmtime`. No header family is complete.

`long double` uses binary80 in the x86-64 Linux profile, and its `%L` conversions preserve the exact value without going through `double`. `<wchar.h>`, `wchar_t`, `wint_t`, `WEOF`, the wide `<stdlib.h>` functions (`mbtowc`, `wctomb`, `mbstowcs`, `wcstombs`), and other wide-character APIs are listed as `Unplanned`. The implemented P5 scope includes bounded API and narrow-format additions for `<stdio.h>`, `<time.h>`, and `<stdlib.h>`, as well as language declarators and types. The existing `ctype.h`/`string.h` functions under the C locale remain supported; configurable locales (`Unplanned`), `<wctype.h>`, complex and atomic language support (`_Complex`, `_Imaginary`, and `_Atomic`), `<complex.h>`, `<stdatomic.h>`, `<tgmath.h>`, `<threads.h>`, and virtual concurrency are `Unplanned`. P6 implements dynamic VLA `sizeof` and the real-valued `math.h` function set for the target profile, with `MATH_ERRNO` reporting; floating-point exception flags and `<fenv.h>` remain `Unplanned`. Annexes F, G, and K may be evaluated separately; these optional evaluations carry no implementation commitment. Runtime atomic operations, concurrent TLS, and per-thread `errno` depend on the Unplanned concurrency work. Other capabilities outside the P5 and P6 profiles remain outside those plans.

## Numeric profile

| Type | Size | Representation |
| --- | ---: | --- |
| `_Bool`, `char`, `signed char`, `unsigned char` | 1 byte | 8-bit signed `char` |
| `short`, `unsigned short` | 2 bytes | 16-bit integer |
| `int`, `unsigned int` | 4 bytes | 32-bit integer |
| `long`, `unsigned long`, `long long`, `unsigned long long` | 8 bytes | 64-bit integer, stored as `BigInt` |
| Object or function pointer | 8 bytes | 64-bit virtual address |
| `float`, `double` | 4 / 8 bytes | IEEE binary32 / binary64 |
| `long double` | 16 bytes | x87 binary80 value (64-bit significand and 15-bit exponent), with 16-byte storage and alignment |

The profile uses little-endian byte order, 8-bit bytes, two's complement, signed `char`, and `FLT_EVAL_METHOD == 0`. Unsigned integers wrap modulo 2^N. `long double` preserves binary80 in arithmetic, memory, variadic arguments, and `%L` conversions. P6 implements the real-valued `math.h` function set while preserving the target format; it does not promise correct rounding for every input or Annex F conformance. `fma`, `fmaf`, and `fmal` preserve the exact ternary result until rounding once to the result type. Some cases of undefined behavior are detected, including signed overflow, integer division by zero, invalid shifts, uninitialized reads, and accesses outside virtual objects. The engine does not claim to detect all undefined behavior.

## Public entry points

| Import | Responsibility |
| --- | --- |
| `@playground/c11-engine/core` | `prepare`, `execute`, `createExecutionSession`, `createDebugSession`, and synchronous types, with no environment access. |
| `@playground/c11-engine/browser` | `runFile(File)`, `runProject(project)`, and reading through `File.text()`. |
| `@playground/c11-engine/node` | `runFile(path)`, `runProject(project)`, and UTF-8 file reading. |
| `@playground/c11-engine/syntax` | `scanC(source)` and keyword/type lists shared with the editor. |

The core accepts a virtual project:

```ts
interface SourceProject {
  entry: string;
  files: readonly { name: string; source: string }[];
  translationUnits?: readonly string[];
}
```

`files` contains all virtual source and header files. `entry` identifies the main unit, which is also the only translation unit by default. When `translationUnits` is provided, the array declares the C translation units in order; other files can only be included as virtual headers. Quoted includes search beside the current file and in the virtual root; angle-bracket includes search the root and built-in headers. The host filesystem is not consulted.

`PreparedProgram` is immutable and reusable by the same core instance. Its `hasHeapAllocationCalls` field indicates whether any function in the linked program contains a directly resolved call to `malloc` or `realloc`, even if that function has not been called yet. Declarations, `free`, names inside comments or strings, and user functions with those names do not set the flag. Each call to `execute` or `createExecutionSession` creates a new session and resets objects, streams and virtual files, `stdin`, arguments, heap, counters, and output. A prepared program cannot be transferred to another Worker with `structuredClone`.

`runFile` remains a single-file adapter, and `runProject` executes a project. Both adapters return a promise; the core's `prepare` and `execute` are synchronous. The adapter does not start Workers implicitly.

## Input, output, and virtual files

`ExecuteOptions.io` accepts these per-execution inputs:

```ts
{
  argv?: readonly string[];  // Full C vector; defaults to [basename(entry)].
  stdin?: string | Uint8Array;
  files?: readonly { name: string; data: string | Uint8Array }[];
}
```

Strings are UTF-8. Initial files exist only in the virtual stdio system; `fopen` never opens host paths. `stdout` and `stderr` bytes are returned directly as `Uint8Array` in every execution result, including after an error or a limit; a failed preparation produces no output. The interface decodes these bytes as UTF-8 for display.

`execute(program, options)` retains batch mode: configured `stdin` is complete, and reads return EOF immediately when it is exhausted, including when it starts empty. For an interactive session, `createExecutionSession(program, options)` leaves stdin open after the initial bytes. Both APIs accept an optional third argument, `ExecutionRuntimeServices`, separate from `ExecuteOptions` so callbacks are not placed in transferable objects; `wallClock.nowEpochMilliseconds()` takes a function that returns epoch milliseconds as a `bigint`. Without this service, `time()` and `timespec_get()` use the fixed instant in 2024. With it, they query the provider once per call, including within a session, and normalize negative epochs before constructing `timespec`. An application can pass this service from its Worker; the core API does not query the host clock. `time()` has second resolution and may return the same value throughout that second; `timespec_get()` retains the Worker's provider's millisecond resolution. `clock()` keeps the virtual instruction counter. `resume()` runs the same VM until it terminates, fails, reaches a limit, or returns `{ kind: 'input-needed', stdout, stderr, metrics }`. That output consists of accumulated snapshots. The C frame and suspended read remain alive, so resuming does not run the program or its effects again.

When it returns `input-needed`, the consumer appends bytes with `appendStdin(bytes)` and calls `resume()` again. `endStdin()` closes input permanently: all bytes already appended are consumed first, then reads return EOF without requesting more input. An open buffer that is temporarily empty does not set `feof`. Interactive reads published in `CAPABILITIES.interactiveStdinFunctions` are `scanf`, `fscanf`, `getchar`, `getc`, `fgetc`, `fgets`, and `fread`; other reads retain their current behavior. Appended bytes count only once toward `maxIOBytes`; if the limit prevents them from being appended, the next `resume()` returns a `limit` result and preserves prior output. The core does not decode UTF-8 or expose environment callbacks.

`maxIOBytes` is a budget separate from `maxMemoryBytes`. It counts `stdin`, initial files, output bytes, and content resident in virtual files against one shared pool. Overwriting or truncating a file frees the bytes that are no longer resident. The core default is 4 MiB; the UI uses 1 MiB. The virtual filesystem and its streams are reset for each execution.

## Results, metrics, and limits

`prepare` returns `prepared`, `prepare-error`, or `limit`. `execute` returns `terminated`, `runtime-error`, or `limit`. Errors include diagnostics with a `code`, message, file, line, and column; only `terminated` has an `exitCode`. Partial output bytes are preserved in execution results that end with an error or limit.

`EngineMetrics` exposes `prepareMs`, `executeMs`, `sourceChars`, `tokenCount`, `preprocessSteps`, `instructionCount`, and `peakMemoryBytes`. In `ExecutionSession`, `executeMs` accumulates runtime setup and synchronous time spent inside `resume()`; it excludes time spent waiting for the consumer to append stdin. `maxPreprocessSteps` measures preprocessor expansion and translation separately from `maxTokens` and excludes the final EOF. Core defaults:

- Preparation: 1,000,000 characters, 200,000 tokens, 5,000,000 preprocessing steps, and depth 128.
- Execution: 1,000,000 instructions, 16 MiB of C objects, 4 MiB of virtual I/O, and depth 128.

Each limit accepts a non-negative safe integer or `null` to disable it. `maxMemoryBytes` counts parameters, locals, global/static objects, string literals, and virtual heap, not JavaScript process memory. `maxIOBytes` counts virtual input/output bytes, not C memory.

The adapters publish `readMs`, `prepareMs`, `executeMs`, and `totalMs`. Worker startup and communication time are excluded. `AbortSignal` is checked before and after reading and between stages; the synchronous core cannot process new events during execution. For active cancellation and watchdogs, the application terminates the Worker from the parent thread.

## Core usage example

```ts
import { prepare, execute } from '@playground/c11-engine/core';

const prepared = prepare({
  entry: 'main.c',
  translationUnits: ['main.c', 'helper.c'],
  files: [
    { name: 'main.c', source: '#include "helper.h"\nint main(int n, char **v) { return helper(n, v); }' },
    { name: 'helper.c', source: '#include "helper.h"\nint helper(int n, char **v) { return n + (v[0][0] != 0); }' },
    { name: 'helper.h', source: 'int helper(int, char **);' },
  ],
});
if (prepared.kind !== 'prepared') throw new Error(prepared.diagnostics[0].message);

const result = execute(prepared.program, {
  io: { argv: ['demo', 'extra'], stdin: 'input', files: [] },
});
if (result.kind === 'terminated') {
  console.log(result.exitCode, new TextDecoder().decode(result.stdout));
}
```

A Worker-based application can coordinate an interactive session without passing browser objects to the core:

```ts
import { createExecutionSession, prepare } from '@playground/c11-engine/core';

const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
if (prepared.kind !== 'prepared') throw new Error('Could not prepare the program.');
const session = createExecutionSession(prepared.program);
declare function readLine(): Promise<string | null>; // null means EOF in the application.
let progress = session.resume();
while (progress.kind === 'input-needed') {
  // The application receives and decodes the stdout snapshot, then reads a line outside the core.
  const line = await readLine();
  if (line === null) session.endStdin();
  else session.appendStdin(new TextEncoder().encode(`${line}\n`));
  progress = session.resume();
}
```

The consumer resumes whenever input is available or sends EOF; a human wait must live outside the synchronous core. In the application, the execution watchdog pauses during that wait, and `Stop` terminates the Worker, discarding the session without requiring callbacks or cancellation from the engine.

## Debugging: lifecycle and line stepping

`createDebugSession(program, executeOptions?, debugOptions?, runtimeServices?)` uses the same VM and memory as a normal session; the fourth argument lets the host inject the same clock service without changing debug options. Only a debug session collects lifecycle events and enables on-demand inspectors for scalars, arrays, observed static objects, and live heap allocations. Its entry point is always `main`: creation initializes global objects and their initializers, then enters `main`'s root scope before executing the body's first instruction. It retains the `scope-enter` event and initial pause in `main` without publishing its future automatic variables. The VM internally reserves local cells on scope entry; `object-create` and scalar inspection become available when each declaration executes. Parameters are published on function entry, before its first instruction. This timing applies only to debug observability and does not change normal C semantics. `currentLocation()` points to the next source location to execute; it returns `null` if setup fails or the session already has a terminal result.

`CAPABILITIES.preparedProgram.heapAllocationHint` publishes that the prepared program includes `hasHeapAllocationCalls`, a hint computed from resolved calls in the linked IR. `CAPABILITIES.stdlibFunctions` publishes the available `<stdlib.h>` family; `malloc`, `calloc`, `realloc`, `free`, and `aligned_alloc` use the engine's virtual memory. `aligned_alloc` accepts power-of-two alignments up to 65536 bytes and sizes that are multiples of the alignment; otherwise, it returns `NULL` and sets `EINVAL`.

`resume()` executes the current line visit and returns `paused` before the first instruction whose location is on a different file or line. Contiguous instructions on one line are grouped; calls step into the called function. If, during a single `resume()`, the VM returns to the same PC in the same frame, the visit pauses before repeating it. This allows stepping through loops and `goto` statements that return to a line without running it indefinitely. Every step includes accumulated `stdout` and `stderr` snapshots: `paused`, `input-needed`, terminal results, and limits preserve the output emitted up to that point. Each snapshot preserves byte order within its own stream; the two snapshots do not describe global interleaving between `stdout` and `stderr`.

Debug uses the same `ExecuteOptions.io` settings as Run: `argv`, initial `stdin`, and virtual `files`. `printf`/`fprintf` and other stdio functions read and write through the shared `VirtualIO`; `fopen` paths never access the host. As with `createExecutionSession`, stdin remains open after the initial bytes are consumed, so temporary exhaustion is not EOF. If a read needs more bytes, `resume()` returns `{ kind: 'input-needed', location, stdout, stderr, metrics }`; `location` identifies the suspended instruction, and the output buffers are accumulated snapshots, so the prompt can be shown while waiting. Calling `resume()` before appending input returns the same wait state without executing effects. After `appendStdin(bytes)` or `endStdin()`, `resume()` continues the same read and line visit: it preserves already-evaluated arguments, partial conversions, and prior effects, and does not execute the instruction again. `endStdin()` first consumes buffered bytes and then returns sticky EOF. Interactive reads are published in `CAPABILITIES.interactiveStdinFunctions`; `maxIOBytes` limits input and output as in Run. `execute()` retains batch mode, where stdin is complete and exhaustion, including an initially empty buffer, is EOF.

The session API is:

```ts
interface DebugExecutionSession {
  resume(): DebugProgress;
  appendStdin(bytes: Uint8Array): void;
  endStdin(): void;
  currentLocation(): DebugSourceLocation | null;
  drainEvents(): readonly DebugEvent[];
  inspectScalars(): readonly DebugScalarSnapshot[];
  inspectPointers(): readonly DebugPointerSnapshot[];
  inspectStaticObjects(options?: DebugStaticObjectInspectionOptions): readonly DebugStaticObjectSnapshot[];
  inspectArrays(): DebugArrayInspection;
  inspectAggregates(): DebugAggregateInspection;
  inspectHeapObjects(): readonly DebugHeapObjectSnapshot[];
}

interface DebugScalarSnapshot {
  readonly id: number;       // Real allocationId from object-create.
  readonly scopeId: number;
  readonly frameId: number;
  readonly name: string;
  readonly origin: DebugObjectOrigin; // Distinguishes parameters from local variables.
  readonly type: string;
  readonly address: string;  // Exact hexadecimal address.
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string; // Complete value or "?".
}

interface DebugPointerSnapshot {
  readonly id: number; // allocationId of the pointer variable.
  readonly scopeId: number | null;
  readonly frameId: number | null;
  readonly name: string;
  readonly origin: 'variable' | 'parameter';
  readonly duration: 'automatic' | 'static' | 'thread-local';
  readonly region: 'stack' | 'static';
  readonly type: string;
  readonly address: string; // Address of the pointer object itself.
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string; // Stored address in hexadecimal, or "?".
  readonly status: 'uninitialized' | 'null' | 'live' | 'one-past' | 'dangling' | 'unmapped' | 'function';
  readonly target?: {
    readonly allocationId: number;
    readonly byteOffset: number;
    readonly type: string;
    readonly name?: string;
  };
}

interface DebugStaticObjectSnapshot {
  readonly id: number; // Real allocationId from object-create.
  readonly name?: string; // Omitted for string literals.
  readonly origin: 'variable' | 'string-literal';
  readonly duration: 'static' | 'thread-local';
  readonly type: string;
  readonly address: string;
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string;
}

interface DebugStaticObjectInspectionOptions {
  readonly includeStringLiterals?: boolean; // true by default for compatibility.
}

interface DebugArrayInspection {
  readonly arrays: readonly DebugArraySnapshot[];
  /** Roots excluded by maxObjects only; unsupported arrays remain in arrays as descriptors. */
  readonly omittedObjects: number;
}

interface DebugArraySnapshot {
  readonly rootId: number; // Real allocationId from object-create.
  readonly name?: string; // Omitted for string literals.
  readonly origin: 'variable' | 'string-literal';
  readonly duration: 'automatic' | 'static' | 'thread-local';
  readonly region: 'stack' | 'static';
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly type: string;
  readonly elementType: string;
  readonly address: string;
  readonly size: number;
  readonly length: number;
  readonly readOnly: boolean;
  readonly status: 'available' | 'too-many-elements' | 'multidimensional' | 'unsupported-element-type';
  readonly elements: readonly DebugArrayElementSnapshot[];
}

type DebugArrayElementSnapshot =
  | {
      readonly key: string; // `${rootId}:${index}`
      readonly index: number;
      readonly address: string;
      readonly type: string;
      readonly initialized: boolean;
      readonly displayValue: string; // Arithmetic value or "?" when indeterminate.
      readonly valueTruncated: boolean;
      readonly kind?: undefined; // Omitted on arithmetic cells to preserve their existing shape.
      readonly pointerStatus?: undefined;
      readonly target?: undefined;
    }
  | {
      readonly key: string;
      readonly index: number;
      readonly address: string; // Storage address of this pointer element.
      readonly type: string;
      readonly initialized: boolean;
      readonly displayValue: string; // Stored pointer value, or "?" when indeterminate.
      readonly valueTruncated: false;
      readonly kind: 'pointer';
      readonly pointerStatus: 'uninitialized' | 'null' | 'live' | 'one-past' | 'dangling' | 'unmapped' | 'function';
      readonly target?: {
        readonly allocationId: number;
        readonly byteOffset: number;
        readonly type: string;
        readonly name?: string;
      };
    };

interface DebugHeapObjectSnapshot {
  readonly id: number;      // Real allocationId from object-create.
  readonly address: string; // Exact hexadecimal address.
  readonly size: number;    // Bytes requested from malloc.
  readonly origin: 'heap';
}

interface DebugPausedResult extends ExecutionOutput {
  readonly kind: 'paused';
  readonly location: DebugSourceLocation;
  readonly stdout: Uint8Array; // Accumulated snapshot.
  readonly stderr: Uint8Array; // Accumulated snapshot.
  readonly metrics: EngineMetrics;
}

interface DebugInputNeededResult extends ExecutionOutput {
  readonly kind: 'input-needed';
  readonly location: DebugSourceLocation; // Suspended C instruction.
  readonly stdout: Uint8Array; // Accumulated snapshot.
  readonly stderr: Uint8Array; // Accumulated snapshot.
  readonly metrics: EngineMetrics;
}

type DebugProgress = DebugPausedResult | DebugInputNeededResult | ExecuteResult | DebugLimitResult;
```

Minimal example (where `prepared` is an already-prepared `PreparedProgram`):

```ts
import { createDebugSession, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS } from '@playground/c11-engine/core';

const session = createDebugSession(
  prepared.program,
  { io: { argv: ['demo'] } },
  { maxEvents: 20_000, ...DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS },
);
let events = session.drainEvents(); // Includes events emitted during setup.
let progress = session.resume();
while (progress.kind === 'paused') {
  const next = session.currentLocation();
  events = session.drainEvents(); // Events since the previous drain.
  const scalars = session.inspectScalars(); // Current values; does not evaluate or modify C.
  const pointers = session.inspectPointers(); // Addresses and status; never reads the target.
  const staticObjects = session.inspectStaticObjects({ includeStringLiterals: false }); // Current static values; string literals are inspected as arrays.
  const arrays = session.inspectArrays(); // Bounded arithmetic/pointer arrays and string-literal characters.
  const aggregates = session.inspectAggregates(); // Direct struct members with a bounded layout.
  progress = session.resume();
}
events = session.drainEvents(); // Remaining events from the final step.
```

`drainEvents()` returns accumulated events in order since the previous call and empties the pending queue. This includes global objects and the `main` entry, root-scope, and local-object events emitted during session construction. It can be called before the first `resume()` to inspect setup. Draining does not reset the counter or total limit.

`DebugEvent` is a readonly, serializable DTO. `sequence` starts at 1, increases monotonically, and is assigned only to committed events. Event types are `frame-enter`, `frame-exit`, `scope-enter`, `scope-exit`, `object-create`, and `object-delete`. All include `location` (`file`, `line`, `column`) and nullable `frameId`/`scopeId`; frame and scope IDs identify dynamic activations, so recursive calls and each repeated entry into the same block are distinct. Frame events include `functionName`; scope events also include `scopeName`, assigned from the AST. A function body uses its function name, and a bare block uses `block`. Control labels are canonical and omit their conditions: `if(...)`, `while(...)`, `for(...)`, `do { ... } while (...)`, and `switch(...)`; `else` remains `else`. A `for` block uses `for block`. A control statement's compound block produces a single scope activation; nested blocks remain independent activations. A frame event uses its `frameId` and `scopeId: null`; a scope event identifies both.

`inspectScalars()` returns a new readonly, serializable array of DTOs for automatic arithmetic variables whose declarations have executed and parameters in active frames: `_Bool`, `char` types, signed and unsigned integers, `float`, `double`, `long double`, and enums with their enum type name and the profile's integer representation. `origin` distinguishes `parameter` from `variable` using binding metadata and matches the correlated `object-create` event's `origin`; it is not inferred from the name, type, or source location. `CAPABILITIES.debugSession.objectOrigins` publishes the possible values for object events and scalar snapshots. The `id`, `scopeId`, and `frameId` IDs are the same numbers used by object/scope/frame events; `id` matches the `allocationId` of the `object-create` event. `address` is hexadecimal from the BigInt virtual address, without converting through `Number`. The `type` field retains the enum tag, such as `enum State`; the value uses the compatible `int` representation. `initialized` is false when no determinate value is available, and `displayValue` contains `?`; inspecting such an object does not produce `UNINITIALIZED_READ`, initialize it, or change events or location.

`inspectPointers()` publishes named automatic pointer variables and active parameters, along with static or `_Thread_local` pointer variables already observed by the runtime. `id` is the pointer object's actual allocationId; `address` identifies its own storage, while `displayValue` separately shows the stored address formatted with BigInt. An uninitialized pointer retains `initialized: false`, `status: 'uninitialized'`, and `displayValue: '?'`; a null pointer retains `initialized: true`, `status: 'null'`, and `displayValue: '0x0'`. The other states are `live`, `one-past`, `dangling`, `unmapped`, and `function`. `_Thread_local` objects retain `duration: 'thread-local'` even though their region belongs to this session's static storage. When the representation retains provenance, `target` contains the destination's allocationId, exact byteOffset, and designated type. The optional name identifies a root object only when identity, type, and zero offset match. The snapshot does not search by address, inspect the target, or depend on the `inspectArrays()` limit. Pointer elements of arrays are published as cells by `inspectArrays()` and are not repeated here.

A consumer can associate `target` with an `inspectArrays()` cell when `target.allocationId` matches `rootId` and its byteOffset and type exactly match a published cell. This includes arithmetic cells, pointer cells, the actual `\\0` in character arrays, and observed literals. One-past pointers, interior or misaligned offsets, multidimensional arrays, placeholder arrays over the limit, and dangling targets do not produce an association. A retired allocationId is never associated with another object, even if the allocator reuses its virtual address. Inspection does not read values through C or emit events or diagnostics, so a write through `*p` preserves program semantics and a snapshot from an earlier pause remains immutable.

`inspectStaticObjects()` returns the current values of global arithmetic objects, local static objects, and `_Thread_local` objects already created by the runtime, along with the contents of string literals already allocated in memory. Each snapshot retains `duration: 'static'` or `duration: 'thread-local'`; both live in the session's static region, but TLS does not simulate concurrent threads. Snapshots use the allocationId, origin, address, and size from real events; they have no frameId or scopeId because their duration does not belong to a C activation. Scalars reuse the numeric and character formatter; each literal has type char[N], `initialized: true`, and a C-escaped, quoted `displayValue` that includes the NUL terminator. Literals have no name. The `includeStringLiterals: false` option omits literals before reading or formatting their preview; the default remains `true` to preserve the existing contract. A consumer using `inspectArrays()` to display literals should request static scalars with this option so the unbounded legacy preview does not traverse the string in addition to the bounded cells.

`inspectArrays()` returns live roots for arrays declared with automatic, static, or TLS duration, and for observed string literals. TLS objects appear in `region: static` within the engine's single session. A root uses the actual allocationId, retains its name/origin/duration/address/size, and publishes frame/scope for automatic arrays; `region` is `stack` or `static`. Each available cell has an index, virtual address, type, stable identity `${rootId}:${index}`, and `initialized` state. Arithmetic cells retain the same numeric or C character format as scalars. Pointer cells use `kind: 'pointer'`, expose the shared pointer `pointerStatus`, and may include the target allocationId, byte offset, designated type, and matching root name. Their `address` is the element's storage; `displayValue` is the stored pointer value, or `?` when indeterminate. Pointer-cell values are never truncated. An uninitialized element retains `initialized: false` and `displayValue: '?'`; a zero-initialized or partially initialized pointer element is a determinate null pointer with `status: 'null'` and `displayValue: '0x0'`. Function-pointer cells retain `status: 'function'` or `status: 'null'` and have no object target. Characters are shown only as indexed cells, with control characters escaped and `\\0` made visible; no text preview is included. With the default options, an observed literal also remains in `inspectStaticObjects()` with the same ID to preserve that existing API. Memory Viewer groups static and thread-local objects in the `Static / TLS` region, retains `data-duration`, and distinguishes them in its accessible label.

One-dimensional arrays with arithmetic or pointer elements have cells. Pointer-array cells are inspected through the same provenance-aware, non-mutating path as named pointers; they are nested in their array descriptor and do not become separate objects. The fixed pointer-cell limit is 10, further bounded by `maxElementsPerArray`; a runtime-sized VLA uses its captured bound, actual size, and element stride. `int *items[2]` is an array of pointer cells, while `int (*items)[2]` is one pointer object and remains in `inspectPointers()`. Function-pointer elements show their pointer status but do not resolve to a memory target. Multidimensional arrays return `status: 'multidimensional'`; arrays of structs or other unsupported elements return `status: 'unsupported-element-type'`; arrays that exceed the applicable limit return `status: 'too-many-elements'`. In these cases, the descriptor retains its length and metadata, but `elements` is empty; the elements are not traversed. The engine does not limit or reject C execution. `char raw[3] = "abc"` produces three cells and remains a valid C array without a terminator; no NUL is invented and no diagnostic is emitted. By contrast, `char text[5] = "code"` has five cells, and the last displays `\\0`.

`inspectAggregates()` publishes live roots for observed `struct` objects with automatic, static, or TLS duration, along with heap aggregates shown through an effective typed view. The snapshot retains allocationId, address, size, region, and scope/frame when available. A struct with up to ten direct members publishes their names, qualified types, offsets, sizes, and addresses; arithmetic members use the scalar formatter, and pointers publish status, address, and provenance by allocationId/byteOffset. Named bit-fields retain `bitWidth`, `bitOffset` from the least significant bit, and `storageUnitSize`; `offset` points to the beginning of their shared unit. An unnamed zero-width separator is omitted. A flexible member's placeholder publishes `elementSize`, `capacityBytes`, and `length` for the actual allocation extent; if its elements are arithmetic, it also includes cells with the array DTO/format up to `maxElementsPerArray`, plus `status` and `omittedElements`. The `maxValueChars` budget applies as it does for arrays; unsupported element types retain the placeholder without invented values. Snapshots do not evaluate C expressions, follow pointers, materialize subobjects, or modify initialization; saved copies are serializable DTOs independent of later changes. Array, struct, and union members remain placeholders; anonymous members are not flattened. Union roots and structs with more than ten members retain their metadata and size but do not publish members. `padding` contains exact ranges according to the profile's layout. The limit of ten is for display only and does not restrict the supported C language.

The LP64 virtual address space has three disjoint regions published by `VIRTUAL_MEMORY_LAYOUT` and `CAPABILITIES.virtualMemory`: Static `[0x10000, 0x20000)`, Stack `[0x20000, 0x30000)`, and Heap `[0x30000, 0x40000)`. Each has a nominal size of 64 KiB. Starts are aligned to 16 bytes, and each allocation reserves space for its C bytes, a 16-byte guard, and alignment rounding; therefore, the total C bytes that fit depend on the size and number of objects. `maxMemoryBytes` counts only live C bytes, excluding guards, and does not expand a virtual region. Static persists for the session; Stack searches for the first available extent and releases it at scope/frame exit for reuse. Exhausting Static or Stack produces `STATIC_ADDRESS_SPACE_EXHAUSTED` or `STACK_ADDRESS_SPACE_EXHAUSTED`, respectively, with a source location. Heap exhaustion retains the profile's semantics: `malloc` returns `NULL` without a region diagnostic.

`inspectHeapObjects()` returns only live blocks obtained with `malloc` or `realloc`. Each snapshot uses the current allocation's `id`/`allocationId` and address, retains its requested size in bytes, and keeps the opaque `heap` provenance; it does not invent a C type, name, or value. A successful reallocation copies the first `min(old size, new size)` bytes and creates a new object identity, even if it retains the address. `free` and `realloc(p, 0)` immediately remove the block from the view and release its interval; a failed nonzero-size allocation returns `NULL` and preserves the entire previous block. Addresses of other live blocks do not change. The allocator tries pseudorandom locations within `[0x30000, 0x40000)` with bounded search and looks for free gaps if the region is fragmented; its extents consume metadata per live block, not per reserved byte. `CAPABILITIES.virtualMemory.heapAddressRange` publishes the base, exclusive end, nominal capacity, alignment, guard, and the fact that randomization is not cryptographic. `debugOptions.heapAddressSeed`, a 32-bit integer, makes the sequence reproducible only for debug sessions; without a seed, the allocator uses the RNG available in the runtime. `malloc(0)`, `realloc(NULL, 0)`, and `realloc(p, 0)` leave no live blocks. A new call returns current DTOs; snapshots saved by the consumer can display earlier pauses.

Integer and enum values are shown in exact decimal; `_Bool` as `0` or `1`; `char` as a quoted literal with C escapes (for example, `'C'` or `'\n'`); `float` and `double` use the shortest decimal that round-trips to the same value, and `long double` displays its exact binary80 value in hexadecimal. `-0`, `nan`, `inf`, and `-inf` are preserved. Values from scalar inspectors and `inspectStaticObjects()` are complete; the interface decides whether to shorten their display. `inspectArrays()` elements may be truncated according to `maxValueChars`, and `valueTruncated` indicates when that happens.

Inspection is available before the first `resume()`, while paused, and after a terminal result. After normal termination, scopes have already closed and it returns `[]`; after an error or limit, it retains only objects that were still live when the VM stopped. It does not force unwinding or add history state. Each call captures current values, so a consumer that needs history must save the DTOs from each pause.

Object events describe a memory root: `objectId` and `allocationId` have the same allocation ID, `duration` distinguishes `automatic`, `static`, `thread-local`, `heap`, and `compound-literal`, and `origin` distinguishes `variable`, `parameter`, `compound-literal`, `heap`, and `string-literal`. They may include `name`; they also carry a textual `typeSummary`, `addressVirtual` as `bigint`, and `size` in bytes. Automatic variables and automatic compound literals carry the frame and scope IDs that own their duration. Heap, static, thread-local, and string literal objects have `null` in both fields, including when a heap object is removed with `free`. Global and local `static` variables, TLS, arrays, and structs are reported as one root object; their members, elements, and subobjects do not create nodes. Observing events does not read C values, materialize members, or change the state of uninitialized objects.

Automatic objects are reported when their declarations execute, and parameters on function entry. The VM internally reserves local cells on scope entry; that reservation does not create an early event. Deletion is emitted only for an `allocationId` that already had an `object-create`. The API also reports static objects when first initialized, observable C string literals, and successful heap blocks from `malloc`/`realloc`; `free` and successful reallocation emit the corresponding deletion events if the previous block was tracked. Global objects may emit events during session construction; local `static` objects are created when the VM first reaches their declaration scope. Thus, a local `static` in a function or block that is never reached produces no event. The API reports allocations made by the VM and does not preallocate objects just for debugging. `free(NULL)`, `realloc(NULL, 0)`, `realloc(p, 0)`, invalid frees, and failed allocations do not produce creation events; invalidating a tracked heap block does publish its deletion. Static objects and string literals persist without a synthetic deletion when the program ends. Implementation support objects for `errno`, stdio, `argv`, or variadic functions are not exposed.

`DebugSessionOptions.maxEvents` limits the session's total committed events (100,000 by default), even if the queue is drained. `heapAddressSeed` controls reproducible heap randomization for tests and debugging. `maxObjects` (1,000 by default) limits the roots returned by each bounded inspector (`inspectArrays` and `inspectAggregates`); `omittedObjects` counts those excluded by this budget. `maxElementsPerArray` (10 by default) limits the cells inspected per root and includes NUL and padding zeros; pointer arrays have a hard limit of 10 even if a larger arithmetic-cell limit is configured. `maxValueChars` (256 by default) limits arithmetic array-cell `displayValue` strings, and `valueTruncated` indicates whether one was shortened; pointer values remain complete. Struct members use the fixed `DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers` limit (10) and complete values. The engine exports `DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS` and `DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS`; a host can derive common budgets from them and pass its settings through `debugOptions`. The event budget is reserved before an instrumented operation; if no space remains, `resume()` returns `kind: 'debug-limit'`, `resource: 'maxDebugEvents'`, the limit, a diagnostic, and metrics. The consumer can drain the complete prefix that was emitted; the session stops without silently truncating it or inventing scope/frame exits. An execution limit or error does not force unwinding either. The debug budget is independent of `maxMemoryBytes`; events consume history memory only in debug sessions, while inspectors are generated on demand and do not count as events. There are no write snapshots or history/reverse execution. A normally closed block reports the location of the `}` token retained by the parser; scopes closed by `return` or a jump use the location of that transition. `frame-enter` uses the function declaration, and `frame-exit` uses the explicit `return` or, on fallthrough, the body's closing brace.

## Development and validation

From the repository root:

```sh
pnpm --filter @playground/c11-engine build
pnpm --filter @playground/c11-engine test
pnpm test
```

P1–P4 regressions remain alongside the P5 suites, which cover diagnostics, multiple translation units, layout, and native GCC/Clang comparisons under the LP64 profile. The P6 suite adds VLA runtime-size and debug-inspection fixtures, real math-family checks, output-parameter and errno cases, and fused multiply-add rounding cases, with native GCC/Clang comparisons for defined finite programs. Differential tests use fixed programs and never execute editor text on the host. P6 is implemented within the agreed profile; this does not complete the C11 VLA family or claim full C11 conformance.
