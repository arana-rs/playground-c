# C11 Engine: Matrix and Roadmap

Engine status **0.1.0: the agreed P5 and P6 scopes are implemented in the published profile** in `packages/c11-engine`, with Run/Stop and the console integrated into the editor. P6 covers dynamic VLA `sizeof` and the real-valued C11 `math.h` function set for `float`, `double`, and `long double`, including classification/comparison macros, constants, output parameters, integer-return variants, and errno reporting. The header selects `MATH_ERRNO`; floating-point exception flags and `<fenv.h>` remain `Unplanned`. The C11-based inventory contains 65 families—35 language families, 29 headers, and one optional extension: **49 are partially started, 15 remain unimplemented, and one is implemented**. These figures describe C11 coverage; they are not a commitment to implement every family. Fifteen entries are listed as `Unplanned`. Complex and atomic language support, `_Imaginary`, the four headers, and virtual concurrency are `Unplanned`. Annexes F, G, and K may be evaluated separately; those evaluations carry no implementation commitment. The P5 and P6 scopes do not declare C11 complete or claim conformance with the entire standard.

In this roadmap, “partial” describes coverage of complete C11 families. The stated P5 scope is the finite profile described here and in the regression tests, under x86-64 Linux LP64; it is not a list of supported APIs still awaiting implementation. The functions listed in `CAPABILITIES.stdioFunctions`, `stdlibFunctions`, and `timeFunctions` are implemented by the engine. Variants outside those sets are identified by profile limits, the P6 inventory, or `Unplanned`. This audit found no additional concrete work remaining within the agreed P5 scope, which is implemented; this does not imply full C11 conformance.

## P5: Implemented in the Agreed Profile

The agreed P5 scope covers nine language areas: bit-fields and padding, flexible members, `const`/`volatile`/`restrict`, `_Generic` selection, alignment and `_Static_assert`, storage/linkage/`inline`/`_Thread_local`, declarators and `typedef` compatibility, promotions/conversions/arguments, and duration/representation/effective type. This scope is implemented and tested under the x86-64 Linux LP64 profile described below. The engine retains `completeC11: false`: incomplete coverage of a C11 family does not mean that P5 work remains open.

The agreed scope also includes four library expansions: `<time.h>`; the published narrow APIs and formats from `<stdio.h>` and `<stdlib.h>`; and declarators/declarations and type compatibility, with diagnostics for `restrict` violations covered by the profile. Capabilities outside the profile and blocks removed from this plan are distinguished in the matrix and under “Unplanned”; they are not open P5 work.

For L07/L11, the bounded P5 matrix covers array, function, pointer, and function-pointer declarators and `typedef` aliases; array/function parameter adjustment; composition of arrays and functions across declarations and translation units; visibility in the separate namespaces for typedef names, ordinary identifiers, and tags, including parameter names and prototype-scope tags; type completeness according to declaration, definition, and use context; and argument conversions with default promotions. The profile preserves each enum type's identity, uses `int`-typed enumeration constants, and selects `int` as the compatible integer type for enums; sharing that compatible type does not make distinct enums compatible. Their promotions are to `int`. This matrix does not complete L07/L11 or imply diagnostics for every C11 constraint. Regression tests are distributed across `packages/c11-engine/tests/p5-language.test.mjs`, `p5-language-extension.test.mjs`, `p5-differential.test.mjs`, and `p5-enum-types.test.mjs`.

The bit-field ABI is compared with GCC and Clang for SysV x86-64: units are shared according to the profile layout, unnamed zero-width fields act as barriers, and both compilers treat a plain `int` field as signed. These details of ordering, allocation, and signedness are implementation choices for this profile, not universal C11 rules. Flexible members occupy the allocation's dynamic tail; `sizeof` retains the struct's fixed size, and struct assignment does not copy the tail. `offsetof` supports member paths and constant subscripts, and rejects bit-fields.

Qualified types are preserved in the semantics and DTO type names; internal compiler types are not part of the public API. The target supports explicit power-of-two alignment up to 65536 bytes. `malloc` guarantees 16-byte alignment; `<stddef.h>` defines `max_align_t` with size 32 and alignment 16 in this profile, covering the selected maximum fundamental alignment. `_Thread_local` has its own duration, visible in events and snapshots, but the engine creates only one instance per session and does not implement concurrency. Pointer-to-`uintptr_t` casts can recover the identity of known/live virtual addresses according to the profile.

Evaluation of `volatile` objects remains within the engine's abstract-machine operations; it does not represent hardware access. The dynamic `restrict` detector observes typed, byte-wise, and library accesses, including bounded string operations, and diagnoses modified overlaps across independent associations. It preserves same-chain pointer derivations and common pointer/integer round-trips, distinguishes disjoint subobjects and bit-fields in shared storage units, and permits read-only or no-access cases. Arbitrary integer transformations and integer values reconstructed by library text parsers may lose tracked provenance. `RESTRICT_PROVENANCE_UNKNOWN` reports that uncertainty only when a real overlapping access is observed and at least one access modifies the object; it is not a confirmed C violation. Confirmed independent associations report `RESTRICT_ALIAS`. This runtime checker has finite dynamic coverage. Coverage of effective type, representation, and union punning also does not imply universal UB detection. Positive acceptances and diagnostics are compared with GCC/Clang when the profile shares their implementation choice.

P4 retains the scalars, expressions, control flow, functions, pointers, and objects from P1–P3. It adds C translation phases, trigraphs and line continuations, UCNs, literal concatenation, object-like/function-like/variadic macros, stringizing, token pasting, rescanning, `#undef`, conditionals, includes from virtual files, `#line`, `#error`, STDC pragmas, and published predefined macros. Stringification preserves preprocessing-token spelling, including a UCN such as `\u00E9`, while normalizing whitespace and escaping quotes and backslashes. Each translation unit prepares its own preprocessor state.

String literals are narrow `char` arrays with a terminating NUL. UCNs in ordinary narrow strings produce UTF-8 bytes; `u8` strings also encode raw Unicode source characters as UTF-8. String-literal array initialization accepts `char` and qualified `char` element types; an inferred bound includes the terminating NUL, while an explicit bound may omit it when the source characters fit. Raw non-ASCII source characters in unprefixed strings and wide literal prefixes are unsupported. A one-byte character constant follows the signed-`char` profile. Multi-character constants pack bytes left-to-right into `int`, retaining the low 32 bits; for example, `'ab'` is `0x6162` and `'abcde'` is `0x62636465`. The profile publishes these choices as `CAPABILITIES.stringLiteralProfile` and `CAPABILITIES.characterConstantProfile`.

Projects support multiple translation units. `static` limits linkage to the file, and `extern` links declarations across units; K&R functions, `inline`, `_Noreturn`, global objects, and variadic functions are covered within the tested profile. `main` supports `int main(void)`, parameterless `int main()`, and the form with `argc` and `argv`; the application can configure the full C argument vector, which ends with a null pointer. Variadic functions support the default promotions and `va_start`, `va_arg`, `va_copy`, and `va_end`.

The 17 virtual headers are treated as subsets; they are not read from the host. P4 adds `assert.h`, `ctype.h`, `errno.h`, `inttypes.h`, `iso646.h`, `stdarg.h`, `stdio.h`, and `string.h` to the earlier numeric and memory headers. P5 adds `stdalign.h`, extends `<stddef.h>` with `offsetof` and `max_align_t`, registers `<time.h>`, and expands `<stdio.h>`/`<stdlib.h>`. `stdio.h` publishes the profile's 45 narrow functions, including the `v*` family, file positioning, and operations on virtual files. Streams default to `_IONBF` for immediate output; `setvbuf` supports all three standard modes, and `fpos_t` is `long` with byte offsets. The detailed buffering behavior is documented in the P5 library section below. `time.h` uses the fixed UTC instant `2024-01-01T00:00:00Z` as the core default and accepts a host epoch-millisecond provider per session; Run and Memory Viewer create it inside their Workers. `time()` has second resolution, `timespec_get()` receives millisecond precision from those Workers, `localtime` is equivalent to `gmtime`, and `clock()` scales the instruction counter by 1000. `<stdlib.h>` uses the C locale, an empty virtual environment, a deterministic RNG, and a virtual `system` that fails with `ENOSYS`; `mblen` supports only the one-byte ASCII representation. Conversions requiring `wchar_t`, including `%lc`, `%ls`, `%l[` and wide multibyte functions, are outside the plan. `%a`/`%A` and `%L` are covered in `stdio`; decimal `printf` precision is limited by the existing I/O and work budgets, and hexadecimal precision is capped at 100000 digits. No header is declared complete.

The following are partial: **L01, L02, L03, L04, L05, L06, L07, L08, L09, L11, L12, L13, L14, L15, L16, L17, L18, L19, L20, L21, L22, L23, L24, L25, L26, L27, L28, L29, L30, L31, L32, and L33**; **L10 (`long double` binary80)** is implemented. The 17 partial library families are **B01, B03, B04, B06, B07, B08, B09, B11, B14, B15, B17, B18, B19, B20, B21, B23, and B26**. Two language families, 12 headers, and Annex K remain unimplemented; all 12 unimplemented headers are listed as `Unplanned`. This classification reflects that these standard families are incomplete. Concrete profile limits include, among others, bounded `restrict` diagnostics and less common formats. P6 implements dynamic VLA `sizeof` and the real-valued `math.h` function set with `MATH_ERRNO` reporting within the profile; other C11 families remain partial. Complex and atomic language support, the four related headers, and virtual concurrency are `Unplanned`; TLS independence and per-thread `errno` depend on that concurrency work. Annexes F, G, and K are separate optional evaluations with no implementation commitment. This audit confirmed no additional work in the finite P5 declarator/promotion matrix. `_Noreturn` is already implemented; the `<stdnoreturn.h>` header is listed as `Unplanned`.

The package's [API and concrete coverage](../packages/c11-engine/README.md) are available from `core`, `browser`, and `node`. The core prepares virtual projects and never accesses the host filesystem. `runProject` and `runFile` adapt inputs; each execution resets arguments, input, output, streams, and virtual files. Run takes a copy of the text, prepares it, and executes it in a Worker. Stop terminates it; the console decodes stdout/stderr and preserves partial output on errors or limits.

## Confirmed Decisions

- A custom, incremental engine built from scratch, running locally in the browser and reusable from Node.js; simulated x86-64 Linux data model.
- Define the complete C11 language and library as a roadmap before implementing them.
- Public API that accepts `File` in the browser and a file path in Node.js.
- Measure engine speed with preparation and execution timed separately.
- Run with limits and cancellation; API with configurable limits for benchmarks.
- Console: exit code on completion; diagnostic for read, preparation, or execution errors.

The following inventory is based on C11 and separates implemented capabilities, planned expansions, and `Unplanned` blocks; it does not imply a plan to complete every C11 clause or header. The engine retains `completeC11: false` and does not claim hosted/freestanding conformance or that there are no omissions. POSIX, GNU extensions, syscalls, ELF, assembly, and x86 instruction execution would require another roadmap. The Linux profile does not enable those features.

## Implemented and Target Data Profile

The target profile uses little-endian memory, 8-bit bytes, and LP64. **P1–P5 implement the integer types, `float`, `double`, `long double`, pointers, aggregates, and alignments published in this table; P3 adds accounting for live virtual objects**:

| Type | Value/representation bits | Size / alignment (bytes) |
| --- | --- | --- |
| `_Bool`, `char` | 8 storage bits | 1 / 1 |
| `short` | 16 | 2 / 2 |
| `int` | 32 | 4 / 4 |
| `long`, `long long` | 64 | 8 / 8 |
| Pointer | 64-bit virtual address | 8 / 8 |
| `float`, `double` | binary32 / binary64 | 4 / 4; 8 / 8 |
| `long double` · implemented P4 (L10) | x87 binary80: 64 significand bits and 15 exponent bits; stored in 16 bytes | 16 / 16 |
| `max_align_t` · P5 profile | Struct with `long long` and `long double`; selected `sizeof` is 32 | 32 / 16 |

This target follows the [x86-64 psABI](https://gitlab.com/x86-psABIs/x86-64-ABI/blob/master/x86-64-ABI/low-level-sys-info.tex) and [GCC x86 options](https://gcc.gnu.org/onlinedocs/gcc/x86-Options.html). The profile specifies signed `char`, two's-complement integers, conversion of out-of-range values to signed integers using the low bits, and arithmetic signed right shift. One-byte character constants follow signed `char`; multi-character constants pack bytes left-to-right into `int` and retain the low 32 bits. `sizeof` returns a 64-bit unsigned value. Integers use `BigInt`, never `number`; unsigned arithmetic wraps modulo 2^N, and detected signed arithmetic overflow produces a diagnostic. `struct` members and final size are aligned; `union` members are placed at offset zero, including anonymous members. The byte view is little-endian. Explicit alignment accepts powers of two from 1 through 65536 bytes; heap allocations start at 16-byte alignment. The bit-field ABI is fixed by SysV x86-64 differential tests and is not intended to be portable to other ABIs.

Floating literals are rounded directly to the target format; `float` uses binary32, `double` uses binary64, and `long double` retains binary80. `FLT_EVAL_METHOD` is 0; NaN, infinity, subnormals, and negative zero are preserved. Math functions use the host's `Math` without promising universally correct rounding or bit-for-bit equality between JavaScript engines. Operands/arguments are evaluated left to right where C permits an unspecified order; this does not permit unsequenced accesses. Partial coverage of bit-fields, flexible members, linkage, `offsetof`, `max_align_t`, and alignment is described in their rows; configurable locales remain `Unplanned`, while P6 implements the real-valued `math.h` function set and errno profile. CPU registers do not need to be simulated for this model.

UB detected by the engine stops execution with a diagnostic; universal detection of all UB is not promised. An implementation-defined result must follow the published profile; an unspecified order must document the chosen policy without presenting it as a guarantee for all of C.

## Phases

The labels in this table describe delivery scope; the later matrix separately classifies coverage of complete C11 families. P4 incorporates profile subsets and retains limits relative to C11; P5 and P6 are implemented within their agreed scopes.

| Phase | Delivery | Scope |
| --- | --- | --- |
| P1 · Implemented | First Run | Single file; int main(void), int variables, arithmetic, blocks, assignments, and return; diagnostics, limits, Worker, and console. |
| P2 · Implemented | Computation and control flow | LP64 scalar integers, promotions/conversions, basic float/double, expressions, branches, loops, typed functions, recursion, and five partial headers. |
| P3 · Partially implemented | Objects and memory | Virtual pointers, arrays, structs/unions with named and anonymous members, enums compatible with `int`, initialization, string literals, compound literals, globals, and basic malloc/realloc/free; heap allocations with pseudo-random virtual addresses and a debug view of their live ranges. `realloc(NULL,n)` acts like `malloc(n)`; `realloc(p,0)` frees and returns `NULL`; a failed non-null allocation preserves the previous block. P5 implements its agreed additions for declarations/linkage, `offsetof`, and `max_align_t` within the profile; the corresponding C11 families remain partial, and complete headers are out of scope. |
| P4 · Profile subsets implemented | Translation and base library | Preprocessor and virtual projects, multiple units, variadic functions, stdio, binary80 conversions, `%a`/`%A` and `%L` formats, strings, and base utilities within the profile. The C11 inventory retains capabilities outside this scope: for example, `L06` has expansions assigned to P6, wide stdio formats are `Unplanned`, and headers are provided as subsets. This describes C11 coverage, not open P4 work. |
| P5 · Implemented in the agreed profile | Declarations, layout, and library expansions | Completes the agreed scope of the nine language areas and four expansions described in this roadmap. C11 families remain partial outside that profile; `completeC11` remains `false`. |
| P6 · Implemented in the agreed profile | Language and library profile additions | Dynamic VLA `sizeof` and the real-valued C11 `math.h` function set for `float`, `double`, and `long double`, including classification/comparison macros, constants, output parameters, integer-return variants, and `MATH_ERRNO` reporting. Floating-point exception flags and `<fenv.h>` remain `Unplanned`. |

Annexes F, G, and K may be evaluated separately; these optional evaluations carry no implementation commitment and are outside P6.

## API and Module Boundaries

Portable package implemented as `@playground/c11-engine` 0.1.0 with `core`, `browser`, and `node` entry points, JavaScript ESM, and TypeScript declarations. The core does not import React, DOM, `File`, filesystem, or Worker. It accepts `{entry, files, translationUnits?}`; `files` contains source files and virtual headers, and `translationUnits` defaults to `[entry]`. Quoted includes search beside the current file and in the virtual root; angle-bracket includes search the root and built-in virtual headers. Adapters handle interaction with their environment.

```ts
// core: synchronous; implemented API
prepare(project: SourceProject, options?: PrepareOptions): PrepareResult;
execute(program: PreparedProgram, options?: ExecuteOptions): ExecuteResult;
createExecutionSession(program: PreparedProgram, options?: ExecuteOptions): ExecutionSession;

// browser: reading and execution coordinated by the adapter
runFile(file: File, options?: RunOptions): Promise<RunResult>;

// node: separate input; do not pull node:fs into the browser
runFile(path: string, options?: RunOptions): Promise<RunResult>;
```

`PreparedProgram` is immutable and reusable within the same core instance; its private representation cannot be transferred to another Worker. Each `execute` or `createExecutionSession` opens a new session for locals, globals, heap, and counters without contaminating the next one. `prepare` runs lexer → parser → subset validation → internal representation; `execute` consumes that representation with its own runtime. An unsupported feature is rejected with its location and a diagnostic. Each execution also resets `stdin`, `stdout`, `stderr`, arguments, streams, and virtual files.

`execute` retains batch semantics: stdin is complete from the start, and exhausting it, even when empty, means EOF. `createExecutionSession` leaves stdin open and returns an object with `resume()`, `appendStdin(bytes)`, and `endStdin()`. `resume()` runs the same VM until termination, a diagnostic, a limit, or `{ kind: 'input-needed', stdout, stderr, metrics }`; progressive output is an accumulated snapshot, and the VM retains its stack, frames, evaluated arguments, parser state, and partial writes. Appending bytes and resuming continues that call without repeating effects. The interactive readers are listed in `CAPABILITIES.interactiveStdinFunctions`: `scanf`, `fscanf`, `getchar`, `getc`, `fgetc`, `fgets`, and `fread`; `sscanf` continues to read a finite string in batch mode. A temporarily empty buffer does not set `feof`; `endStdin()` makes EOF sticky after the stored bytes are consumed. Appended bytes use the shared `maxIOBytes` budget; an excess is returned as the normal `limit` result on the next resume, with stdout/stderr preserved.

### Debug API · D1: Events, Line Stepping, and Scalar Inspection

Contract checked against the core types and runtime. Observability is a cross-cutting engine capability: it does not extend the C language, change the coverage matrix, or belong to P5. `createDebugSession` uses the same VM and object management; only a debug session collects events and allows inspection of scalars, observed static objects, and live heap allocations. A normal session creates no collector or debug frame stack and retains its I/O semantics. A debug session always starts at `main`, initializes globals and their initializers, and advances until entering `main`'s root scope before executing its body. It retains the `scope-enter` event and initial pause at `main`, but does not publish its future automatic variables. The VM internally reserves local cells on scope entry; `object-create` and scalar inspection become active when each declaration executes, while parameters are published on function entry, before its first instruction. This timing is debug-only and does not change normal C semantics. Public debug types are exported from `core`, and `CAPABILITIES.debugSession` publishes the exact scope.

```ts
createDebugSession(
  program: PreparedProgram,
  options?: ExecuteOptions,
  debugOptions?: DebugSessionOptions,
): DebugExecutionSession;

interface DebugSessionOptions {
  readonly maxEvents?: number; // Cumulative budget; defaults to 100_000.
  readonly heapAddressSeed?: number; // Reproducible heap randomness for debug/tests.
}

interface DebugExecutionSession {
  resume(): DebugProgress;
  appendStdin(bytes: Uint8Array): void;
  endStdin(): void;
  currentLocation(): DebugSourceLocation | null;
  drainEvents(): readonly DebugEvent[];
  inspectScalars(): readonly DebugScalarSnapshot[];
  inspectStaticObjects(): readonly DebugStaticObjectSnapshot[];
  inspectHeapObjects(): readonly DebugHeapObjectSnapshot[];
}

interface DebugScalarSnapshot {
  readonly id: number; // allocationId from object-create.
  readonly scopeId: number;
  readonly frameId: number;
  readonly name: string;
  readonly type: string;
  readonly address: string; // Exact hexadecimal address.
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string;
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

`debugOptions` accepts `maxEvents` and `heapAddressSeed`; the seed must be an unsigned 32-bit integer. A `null` object, unknown keys, or values outside those ranges produce a diagnostic.

Each event has `sequence: number`, `kind`, `location` (`{ file, line, column }`), and `frameId`/`scopeId` (`number | null`). `kind` can be `frame-enter`, `frame-exit`, `scope-enter`, `scope-exit`, `object-create`, or `object-delete`; frame events include `functionName: string`, and scope events also include `scopeName: string`, assigned from the AST. A function body uses its function name, and a bare block uses `block`. Control labels are canonical and omit their conditions: `if(...)`, `while(...)`, `for(...)`, `do { ... } while (...)`, and `switch(...)`; `else` remains `else`. A `for` block uses `for block`. A compound control block produces one activation; nested blocks remain independent activations. `frameId` and `scopeId` identify a function activation and a scope activation, respectively. `location` points to the operation available in the runtime; returns and jumps use the location of their operation. Normal block exit reports the location of the `}` token retained by the parser; scopes closed by `return` or a jump use the location of that transition. `frame-enter` uses the function declaration, and `frame-exit` uses the explicit `return` or, on fallthrough, the body's closing brace. Events correlate activations, scopes, and objects without recording instructions or value accesses.

`inspectScalars()` takes a fresh snapshot of already-published automatic arithmetic variables and parameters whose frames remain active. A local variable appears after its declaration executes; a parameter appears on function entry. It includes `_Bool`, `char`, signed/unsigned integers, `float`, `double`, `long double`, and enums represented as `int`. Numeric IDs match the actual events (`id === allocationId`), and `address` converts the BigInt virtual address to hexadecimal. An indeterminate object is returned as `initialized: false` and `displayValue: '?'`; the query does not perform a C read or change memory, events, or location. Integers and enums are shown in exact decimal, `_Bool` as `0`/`1`, char as a C literal with escapes, `float`/`double` using a short round-trip decimal, and `long double` in exact binary80 hexadecimal, with `-0`, `nan`, `inf`, and `-inf` made explicit. Enums use the type name `int`, as in the engine's current model. This inspection does not read arrays, pointers, structs, or unions.

The LP64 virtual layout published by `VIRTUAL_MEMORY_LAYOUT` and `CAPABILITIES.virtualMemory` separates Static `[0x10000, 0x20000)`, Stack `[0x20000, 0x30000)`, and Heap `[0x30000, 0x40000)`, each with a nominal 64 KiB. Initial addresses are aligned to 16 bytes; each object also reserves a 16-byte guard and the corresponding rounded space, so effective C bytes depend on live allocations. `maxMemoryBytes` counts only C bytes and does not extend these ranges. Static persists for the session; Stack uses ordered first-fit and returns extents when a scope/frame closes. Exhaustion produces `STATIC_ADDRESS_SPACE_EXHAUSTED` or `STACK_ADDRESS_SPACE_EXHAUSTED`. Heap exhaustion preserves `malloc`'s behavior of returning `NULL` without a region diagnostic.

`inspectHeapObjects()` returns live `malloc` allocations sorted by BigInt virtual address and serialized as hexadecimal; each DTO contains `id`, `address`, `size`, and `origin: 'heap'`, without inventing a C name, type, or value. `free` removes the block from the view and releases its range without moving other allocations. `CAPABILITIES.virtualMemory.heapAddressRange` publishes the reserved interval `[0x30000, 0x40000)`, nominal capacity, 16-byte alignment, and the 16-byte guard that prevents a one-past address from sharing the next heap base address. Selection uses bounded pseudo-random probes and first-fit over live extents; metadata cost depends on the number of blocks, not the reserved bytes. `heapAddressSeed` makes the non-cryptographic RNG reproducible in debug sessions. The view is empty after normal termination; it does not inspect typed heap values.

`currentLocation()` identifies the next source position to execute, or returns `null` if setup fails or a terminal result already exists. `drainEvents()` also collects events emitted while the session is created; it can be called before the first `resume()` to inspect initialization and entry into `main`. It returns events since the previous drain and does not reset the counter or total limit. `inspectScalars()` is available before stepping, during pauses, and after terminal results: after a normal return it returns `[]`; after an error/limit it retains only objects live in the VM's stopped state, without synthetic unwinding. The method creates new serializable DTOs when requested; the consumer retains a copy per pause if history is needed. Snapshots do not consume `maxEvents`.

`DebugProgress` adds `paused` and `input-needed` alongside terminal results and the debug-specific limit. Pauses, waits, and terminal results all carry accumulated `stdout` and `stderr` snapshots. `createDebugSession` reuses the complete `ExecuteOptions.io`: `argv`, initial `stdin` bytes, and virtual `files`, with the same `VirtualIO` and stdio dispatch as Run. Interactive stdin remains open after the initial bytes; a reader that temporarily exhausts its buffer returns `input-needed` with the suspended C location and leaves the emitted prompt visible. `appendStdin(bytes)` and `endStdin()` feed or close the same session; resuming continues the generator and line visit while preserving evaluated arguments, partial conversions, memory state, and effects, without executing the instruction again. A call to `resume()` while waiting returns the wait result and its snapshots without advancing. `endStdin()` produces sticky EOF after pending bytes are consumed. `maxIOBytes` shares the execution budget used by Run; batch `execute()` retains EOF when the initial stdin is exhausted. Paths remain virtual, and the core does not use DOM, `File`, `Worker`, or the host filesystem.

Object events describe the program's actual storage roots: they include `objectId`/`allocationId: number`, `duration`, `origin`, `typeSummary: string`, `addressVirtual: bigint`, and `size: number`, plus `name?: string` when available. For each root, `objectId` and `allocationId` contain the same ID and correlate creation/deletion. `duration` distinguishes `automatic`, `static`, `thread-local`, `heap`, and `compound-literal`; `origin` distinguishes `variable`, `parameter`, `compound-literal`, `heap`, and `string-literal`. Scalar snapshots carry the same typed `origin` as their creation event, so the UI can identify parameters from binding metadata. An array or struct emits one root: no separate events are created for elements or members, and lazy subobjects are not forced into existence. C-observable string literals are included; infrastructure objects such as `errno`, `argv`, and internal `va_list` storage are excluded.

Objects with automatic duration and block-scope compound literals belong to an activation and end when their scope exits; heap objects end when released with `free`. In creation and deletion events, `frameId`/`scopeId` identify the lifetime owner for these objects; they are null for heap, static, thread-local, and string-literal objects. Static, thread-local, and literal objects are created once per session and receive no synthetic deletion when the program ends. Ordinary automatic objects are published when their declaration executes; parameters are published on function entry. An internal cell may be reserved when its scope is entered, but there is no `object-create` or visible snapshot before that point in execution. Scope exit emits `object-delete` only for a root that already had `object-create`, with the same `allocationId`; errors and limits preserve state without synthetic unwinding. D1 traces only allocations made by the current runtime; it is not a static inventory of all C declarations: local static objects are created when their scope is reached, so an unreached function or block emits no such event. Global events may be emitted while the session is constructed, before the first `resume()`. `drainEvents()` returns everything accumulated since the previous drain, in sequence order.

The `maxEvents` budget counts every event in the session and is not reset by draining. If exceeded, the session returns the debug result `kind: 'debug-limit'`, `resource: 'maxDebugEvents'`, with `limit`, `diagnostics`, `metrics`, and accumulated output snapshots; it preserves the emitted prefix and does not silently discard events. The limit is checked before mutating the state that would produce the excess event. This result belongs to `DebugProgress` and does not extend `ExecuteResult` or `LimitResource` for normal sessions.

### Debug API · D1 (Stage 2): Line Stepping

Each `resume()` executes the current line visit and pauses with `kind: 'paused'` before the first instruction located on another file or line. Contiguous instructions on the same line form one visit; calls step into the called function. If the same PC is re-entered in the same frame during a single `resume()`, it pauses before repeating it, allowing stepping through loops and `goto` statements that return to the same line. `location` and `currentLocation()` point to the next position, before its instruction executes.

D1 reports creation and deletion of frames, scopes, and objects; supports line stepping; and inspects observed automatic scalars, static or thread-local objects, arrays, structs, pointers, and live heap allocations. `inspectArrays()` returns roots with metadata and per-element cells for observed one-dimensional arrays of arithmetic or pointer types and string literals. Pointer cells use the same non-mutating pointer-state and provenance inspection as named pointers; each retains the array root identity, scope and duration, and stable `rootId:index` key. The pointer cell's `address` identifies its own storage, while `displayValue` is the stored address or `?`. Pointer cells are included only under their array root, not duplicated by `inspectPointers()`. `inspectAggregates()` returns automatic and static structs/unions, as well as effective typed views of heap aggregates. It publishes up to 10 direct members per struct: each arithmetic or pointer member includes its state; bit-fields include width, bit offset, and shared storage unit; flexible members report element size, capacity, and actual length; if they contain arithmetic elements, they include cells with the same limits and truncation as arrays. Nested arrays and aggregates retain placeholders with offset and size. A union or struct that exceeds this limit retains one global placeholder. In heap snapshots, `rootId` identifies the allocation and `viewId` distinguishes typed subobjects; address and size describe the view range. `inspectPointers()` returns snapshots of named pointer objects with their own identity and address, initialization state, stored value, and, when available, the identity and offset of their target. The target includes no address or read value, does not traverse graphs, and does not change C state. `DebugSessionOptions` limits roots with `maxObjects` and cells with `maxElementsPerArray`; pointer arrays have a hard 10-cell maximum and small VLAs use their captured runtime bounds and stride. The direct-member limit is 10. If an array root cannot provide cells, its descriptor/status is retained. `omittedObjects` counts roots omitted by each inspector.

In the application, Memory Viewer queries snapshots from `inspectScalars()`, `inspectStaticObjects()`, `inspectArrays()`, `inspectAggregates()`, and `inspectPointers()` after every `resume()` and retains those states for navigation with Previous/Next. For the same object or array-cell identity, it marks a change when `initialized` or `displayValue` differs; pointer cells also compare pointer status and target identity/offset. A write through `*p` can change the scalar, cell, or target member while the address stored in `p` remains the same. For an indeterminate value, the DTO retains `displayValue: '?'`; the viewer card shows `—`, with no helper text in Minimal and “Uninitialized” in Normal/Debug. Previous/Next navigates captured snapshots; it does not reverse the VM or repeat writes.

Capture granularity is one line visit. `resume()` groups contiguous instructions on a line and returns the state at the end of that visit; if a line writes the same object several times, the snapshot retains only the line's final result. The view shows values after each pause, not a trace of each write or the operator that produced it. To see separate mutations, each operation must be on a different line.

### Memory Viewer · Arrays and String Literals

Memory Viewer shows one-dimensional arrays in their region (Stack or Static / TLS) as a contiguous block, with one cell per element and its index. TLS uses the static region of the single session, retains `duration: 'thread-local'`, and appears with that accessible label. String literals are represented only by their cells, without a duplicate text preview; NUL appears as `\0` in Minimal, Normal, and Debug. In Minimal, array indices appear on pointer hover or accessible keyboard focus; in Normal and Debug they are always visible.

Up to 10 actual cells are shown per array, including NUL and padding zeros. A larger array gets the local placeholder “Maximum 10 elements”; matrices get an informative local fallback. Neither case limits or stops C execution. This is a current visual limit; support for larger arrays and matrices is not planned.

### Memory Viewer · Structs, Unions, and Padding

A struct is shown in its Stack or Static / TLS region as a block containing its direct members; typed views of heap structs are also shown when the runtime can associate an effective type with an allocation. Up to 10 members are retained: arithmetic and pointer fields show values and states, while array or nested-aggregate fields use a local placeholder that retains the name, offset, address, and size. Bit-fields show their bit range and the size of their shared unit; they are not assigned an exclusive byte range that would falsely overlap other fields. A flexible member retains its fixed offset and shows its dynamic length and capacity. A union or struct with more than 10 members uses a global placeholder. None of these presentations limits or stops C execution.

Minimal always keeps each field name visible and shows the object's alias below the block. Normal and Debug show the root and each field's address, type, size, offset, and actual internal or trailing padding ranges. Padding uses labels with its offsets and sizes; it is not drawn as a byte-proportional scale. Snapshots per line visit are saved in history, so Previous/Next restores values, initialization states, and `Δ` markers without rerunning the VM.

Member pointers reuse the focus and hover behavior of scalar pointers and distinguish uninitialized, NULL, live, one-past, dangling, and unmapped states. When the visible target matches by allocationId, offset, and type, a compatible struct root or the exact field is highlighted; a `struct S *` to the root is not confused with a primitive pointer to the first field, even when both use offset zero. Nested members are not expanded, and pointers are not followed to traverse graphs.

### Memory Viewer · Pointers and Array Cells

The viewer shows scalar pointer objects and distinguishes their storage from the stored address: `address` is the pointer object's own address, and `displayValue` shows its current value, such as `0x...`, `0x0`, or `?`. `target` retains the allocation identity and byte offset when the target can be identified. An uninitialized pointer and a null pointer have distinct states.

Hovering over a pointer or focusing it with the keyboard highlights a scalar or array cell when its allocation is still live. For arrays, the cell is resolved by `allocationId === rootId`, exact byte offset, and type; the calculation uses integer virtual addresses without losing precision. Linking does not compare visible addresses alone. `p++` retains `p`'s identity and own address while moving its target to the next cell. A write through `*p` marks the cell as changed and leaves the pointer snapshot unchanged. For strings, `char *q = text` and `q++` link to each character, including `\0`. Previous/Next restores each relationship and value from immutable history, without rerunning C.

Only targets with a visible identity and cell are resolved: one-past pointers, misaligned offsets, dangling pointers, IDs without a live root, and placeholder arrays are not linked. Scalars retain links by root identity and offset zero. The 10-cell limit and matrix placeholder described above remain in effect.

The current scope includes pointers to available one-dimensional array cells and literals/strings with up to 10 visible cells, as well as compatible struct roots and their visible direct fields. Heap views replace the raw block only when they cover the allocation exactly; a partial or offset view leaves the full raw block visible to preserve bytes outside it. Larger array cells and matrices, partial heap subviews, unsupported nested members, function pointers, and reference graphs have no visual link.

The presentation follows C values per element and does not invent terminators. `int a[4] = {10, 20}` is shown as `10, 20, 0, 0`; `char text[5] = "code"` as `c, o, d, e, \0`; and `char raw[3] = "abc"` is valid without `\0`. For uninitialized automatic objects, each cell retains `initialized: false`: Minimal shows `—` without a legend, and Normal/Debug adds “Uninitialized”. Partial initialization zeroes omitted elements. `char text[] = "abcdefghij"` has 11 cells including NUL and receives the placeholder because it exceeds the limit.

History retains immutable snapshots per line visit, and Previous/Next restores them without reversing or rerunning the VM. `Δ` is marked only on a cell whose value or initialization state changed; operations that should appear separately must be on different lines. The inspection limit and placeholder do not change program state, and addresses use the existing LP64 conversions.

Implemented discriminated results:

- `prepared`: program ready; internal preparation result.
- `terminated`: `exitCode`, `rawExitStatus`, and `mainReturn` when applicable.
- `read-error` / `prepare-error` / `runtime-error`: diagnostics for their stage.
- `limit`: exhausted resource and limit; `cancelled`: external cancellation.

When `main` returns normally, the Linux profile exposes an `exitCode` from 0 through 255 and retains the original status: returning 256 yields `mainReturn: 256`, `rawExitStatus: 256`, and `exitCode: 0`. `exit(status)` terminates with that status and runs `atexit` handlers in LIFO order; `quick_exit(status)` runs only `at_quick_exit` handlers, also in LIFO order. `_Exit(status)` and `abort()` terminate without running those handlers; `abort()` uses the profiled status 134. Explicit termination does not invent a return from `main`. Errors, limits, and cancellation do not fabricate a successful exit code. Signals and `<signal.h>` remain `Unplanned`. [Linux exit(3)](https://man7.org/linux/man-pages/man3/exit.3.html).

## Performance and Cancellation

The adapters already publish `readMs`, `prepareMs`, `executeMs`, and `totalMs`. Reading/decoding is part of `readMs`; creating and resetting the session is part of `executeMs`; `totalMs` measures the complete adapter call. The core separates preparation and execution and reports characters, tokens, instructions, and maximum virtual storage. Worker startup, communication, and termination are outside those measurements and can be measured from the parent thread as additional time.

It is already possible to prepare once and call `execute` repeatedly with independent sessions; the package README includes an example. A dedicated benchmark helper with warmup and samples remains future work. Tracing and per-instruction callbacks are also future work; the Debug API emits lifecycle events and scalar snapshots when requested.

P4 provides configurable limits for characters, tokens, preprocessor steps, and preparation depth, as well as instructions, C memory, virtual I/O, and execution depth. The UI uses **100,000 characters, 25,000 tokens, 1,000,000 preprocessor steps, depth 128 per stage, 100,000 instructions, 1 MiB of C memory, 1 MiB of virtual I/O, and a 10-second watchdog** from the Worker parent. These are published initial budgets, not declared optimal thresholds. Core defaults are separately exported as `DEFAULT_PREPARE_LIMITS` and `DEFAULT_EXECUTE_LIMITS`; the API accepts non-negative safe integers and explicit disabling with `null` for benchmarks. During an interactive session, `executeMs` accumulates synchronous setup time and each `resume()`, excluding human wait time; the Worker pauses the execution watchdog while waiting for stdin and reactivates it when a line arrives. Stop terminates the Worker and discards the session. `maxMemoryBytes` limits and `peakMemoryBytes` reports the bytes used by live C objects: parameters, locals, globals and static objects, string literals, and heap; these are not equivalent to JavaScript process memory use. Explicit stacks allow deep recursion without using the host call stack; infinite loops and recursion stop when budgets are exhausted.

The UI already prepares and executes in a Worker. The parent thread terminates it when Stop is pressed or the watchdog expires. Adapters accept `AbortSignal` and check for cancellation before and after reading and between stages. The synchronous core checks budgets at defined points: a new `AbortSignal` cannot interrupt it while the same thread is busy and not processing events. The Node adapter does not yet create a Worker; consumers can integrate one for active cancellation. Direct `execute` remains synchronous and budget-limited. Cancellation discards the session, preserves the text, and allows the next Run.

P4 introduces virtual ports for stdin/stdout/stderr and files. `maxIOBytes` separately limits input, output, and content resident in the virtual filesystem. P5 adds `<time.h>` with a UTC calendar, deterministic core default, and wall clock injectable through session services; Run and Memory Viewer create that provider inside their Workers. `<stdlib.h>` retains an empty virtual environment; signals and the host environment remain outside the core, and the host environment is listed as `Unplanned`. The interface decodes output bytes as UTF-8 text. In interactive mode it publishes the snapshot before waiting for more data; the application computes and displays the delta. The core receives only UTF-8 bytes or raw bytes and does not import DOM, Worker, decoders, or application callbacks.

## Language Matrix

**32 partial C11 families**, listed in “P5: Implemented in the Agreed Profile”; the other **2 language families remain outstanding**. No C11 family is complete. The following columns describe each family's scope and acceptances, including capabilities that are still rejected; this classification does not reopen the implemented P5 scope or imply that a family is complete. Each acceptance is a minimal example and is not sufficient to demonstrate conformance. Inventory compared against [WG14 N1570, §§5–6](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf).

| ID | Area and scope | Phase | Proposed minimal acceptance |
| --- | --- | --- | --- |
| L01 | Input, termination, and main with argv | P1→P4 | `main(void)`, parameterless `main()`, and `main(argc, argv)`; the vector ends in NULL. |
| L02 | Diagnostics, constraints, and behavior | P1→P6 | Invalid syntax identifies file/line; detected signed overflow stops the session. |
| L03 | Lexer: tokens, UCNs, escapes, trigraphs, and concatenation | P1→P4 | UCN UTF-8 bytes remain separate from following hex digits; `u8` raw Unicode and UCN bytes, escaped backslashes, literal concatenation, and the profile's multi-character packing behave as published. |
| L04 | Includes and conditionals | P2→P4 | Virtual numeric header in P2; #if defined(X) and general includes in P4. |
| L05 | Macros: arguments, variadic, #, ##, and rescanning | P4 | Nested macro expands correctly once; #undef removes the definition. |
| L06 | Provenance, predefined macros, and STDC pragmas | P4→P6 | #line, #error, _Pragma, __FILE__/__LINE__, and verifiable capabilities. |
| L07 | Names, typedef, declarators, and compatible types | P1→P5 | Finite matrix of pointers, arrays, functions, function pointers, and `typedef`; arrays completed by an initializer, adjusted parameters, scopes and namespaces, and context-dependent incomplete types; arrays/functions composed across declarations and units; incompatibilities diagnosed. |
| L08 | Integers, _Bool, and LP64 literals | P1→P2 | Exact 9007199254740993ULL; unsigned wrap; profile sizes. |
| L09 | float/double, decimal and hexadecimal literals | P2 | (float)16777217 rounds to 16777216; ±0, NaN, and infinity are preserved. |
| L10 | long double binary80 | P4 | `sizeof(long double)==16`; `1.0L+0x1p-63L != 1.0L`; binary80 storage and 16-byte alignment. |
| L11 | Promotions, conversions, casts, and arguments | P1→P5 | `_Bool`, small integers, and enums promote to `int` in this profile; `float` promotes to `double` in variadic/no-prototype arguments; conversions to parameters and between signed and unsigned integers follow LP64; prototype compatibility versus no-prototype declarations, distinguishing `f()` from `f(void)`. |
| L12 | Unary, prefix/postfix, and access | P1→P3 | Cover + - ! ~ & * [] . -&gt; () with objects/functions; distinguish ++i from i++. |
| L13 | Arithmetic, bits, and comparisons | P1→P2 | -7/3==-2; remainder, shifts, & ^ \|, and comparisons at the limits. |
| L14 | Short-circuit, ternary, comma, and sequencing | P2 | 0&&f() does not call f; ?: selects one branch; comma sequences effects. |
| L15 | Lvalues and simple/compound assignments | P1→P2 | a[i++] += 2 computes the destination only once. |
| L16 | Blocks, if/else, and switch | P1→P2 | Local scope, fallthrough, and default produce the expected result. |
| L17 | for, while, and do | P2 | A for declaration and continue respect the condition and increment. |
| L18 | Labels, goto, break, continue, and return | P1→P2 | Valid jump to a label; restricted scope crossings diagnosed. |
| L19 | Calls, parameters, frames, and recursion | P1→P3 | Recursive factorial; independent values; call through a typed pointer. |
| L20 | Prototypes and older definitions valid in C11 | P2→P4 | Typed/incompatible prototypes in P2; valid K&R definition in P4. |
| L21 | Variadic functions | P4 | va_start/arg/copy/end; float→double and small-integer promotions. |
| L22 | Virtual pointers, arithmetic, and conversions | P3 | Null, void*, offset, subtraction, and one-past within the same array; out-of-object access fails. |
| L23 | Objects, duration, representation, and effective type | P1→P5 | Automatic, static, heap, and per-session TLS duration; little-endian bytes, observable copy/effective type, and diagnosed use after free, without a universal UB detector. |
| L24 | Arrays, strings, and decay | P3 | Multidimensional array; sizeof preserves type; string literal includes NUL and is not modifiable. |
| L25 | Structs/unions and anonymous members | P3 | Copy, pass, and return aggregates; access with . and -&gt; to named members and members promoted from anonymous struct/union. |
| L26 | Enums and constant expressions | P3 | Each enum type retains its identity even though the profile selects `int` as its compatible integer type; int-typed enumerators, explicit/implicit values in range, and ICEs; duplicates, non-ICE values, and out-of-range values rejected. |
| L27 | Padding, bit-fields, and flexible member | P5 partial | Units, padding, zero-width barrier, extraction/sign, and final FAM compared against GCC/Clang SysV x86-64; `sizeof` and assignment omit the dynamic tail. |
| L28 | Initialization and designators | P1→P3 | Omitted zeros, nested arrays/aggregates, brace elision, .member, and [index]. |
| L29 | Compound literals | P3 | Stable address within a block and static duration at file scope. |
| L30 | const, volatile, and restrict | P5 partial | Preserves qualifiers and volatile evaluation. Runtime diagnostics cover typed, byte-wise, and observed library accesses, with exact ranges for bounded string operations. Same-chain derivations, common pointer/integer round-trips, read-only/no-access cases, disjoint subobjects, and distinct bit-fields sharing storage are accepted. Arbitrary integer transformations and values reconstructed from library text may have unresolved provenance. `RESTRICT_ALIAS` identifies a confirmed independent association; `RESTRICT_PROVENANCE_UNKNOWN` reports uncertainty after an observed modified overlap and does not claim confirmed C undefined behavior. This is not a universal UB detector. |
| L31 | Storage, linkage, inline, _Noreturn, and _Thread_local | P4→P5 | Block-scope `extern`, linkage, C11 external inline, `_Noreturn`, and TLS serialized per session; TLS independence across threads depends on Unplanned virtual concurrency and `<threads.h>`. |
| L32 | sizeof, _Alignof, _Alignas, and _Static_assert | P2→P5 | Explicit alignment up to 65536 (heap 16), profile `max_align_t` of 32/16, nested `offsetof`, and valid ICEs; non-ICE expressions rejected. |
| L33 | _Generic | P5 partial | Type compatibility, lvalue conversions, and unevaluated associations; correct selection in expressions and integer constant expression contexts. |
| L34 | Variable-length arrays and complex language support | P6 implemented in profile (VLA only); Unplanned (complex) | Runtime bounds are captured for each VLA instance; runtime `sizeof` covers array expressions and VLA type names, including nested dimensions, typedefs, pointer-to-VLA stride, and adjusted array parameters. The profile enforces positive integer run-time bounds, no linkage for VM identifiers, block/prototype scope, and no VLA initializers. VLA array objects cannot have static or thread storage duration; pointers to VLA types may have static storage duration. `_Complex` arithmetic and `_Imaginary` language support are `Unplanned`. |
| L35 | _Atomic language support and concurrent memory model | Unplanned | `_Atomic` types and operations, memory-order behavior, and the concurrent memory model are `Unplanned` and depend on virtual concurrency. |

C11 coverage of L07/L11 remains partial: P5 implements and tests the agreed profile combinations, not every declarator production or every standard constraint. Incomplete types are retained in permitted declarations, including an incomplete `struct` return type in a prototype; definitions and uses requiring completeness are validated in context. The related matrix is in `packages/c11-engine/README.md`; its regression tests use `packages/c11-engine/tests/p5-language.test.mjs`, `p5-language-extension.test.mjs`, `p5-differential.test.mjs`, and `p5-enum-types.test.mjs`.

## Standard Library Matrix

The inventory includes all 29 C11 headers. P1–P3 partially started **B06 (`float.h`), B09 (`limits.h`), B11 (`math.h`), B17 (`stdbool.h`), B18 (`stddef.h`), B19 (`stdint.h`), and B21 (`stdlib.h`)**. P4 adds **B01 (`assert.h`), B03 (`ctype.h`), B04 (`errno.h`), B07 (`inttypes.h`), B08 (`iso646.h`), B15 (`stdarg.h`), B20 (`stdio.h`), and B23 (`string.h`)**. P5 adds **B14 (`stdalign.h`)** and partially expands **B20**, **B21**, and **B26 (`time.h`)**. **12 headers remain unimplemented, and all 12 are listed as `Unplanned`**. P6 publishes the real-valued `math.h` function set and its `MATH_ERRNO` error behavior; `<fenv.h>` remains `Unplanned`, and no claim is made about Annex F. No header family is declared complete. The following acceptances describe each family's target, including items that remain outside the profile. [WG14 N1570, §7](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf).

| ID | Area and scope | Phase | Proposed minimal acceptance |
| --- | --- | --- | --- |
| B01 | &lt;assert.h&gt; · assertions | P4 | A true assert continues; a false one terminates abnormally with a diagnostic; NDEBUG disables it. |
| B02 | &lt;complex.h&gt; · complex families | Unplanned | Complex library macros and functions; depends on the `Unplanned` `_Complex` language support in L34. |
| B03 | &lt;ctype.h&gt; · classification and transformation | P4 | Classification and transformation under the C locale; integration with configurable locales remains `Unplanned` alongside B10. |
| B04 | &lt;errno.h&gt; · library errors | P4 | Out-of-range conversion sets `ERANGE`; per-thread `errno` depends on Unplanned virtual concurrency and `<threads.h>`. |
| B05 | &lt;fenv.h&gt; · floating-point environment | Unplanned | Save/restore the environment and inspect flags and rounding; Annex F is a separate optional evaluation with no implementation commitment. |
| B06 | &lt;float.h&gt; · floating-point limits | P2→P5 | Radix 2; significands 24/53/64; LDBL_* macros match binary80; FLT_EVAL_METHOD matches actual evaluation. |
| B07 | &lt;inttypes.h&gt; · formats and wide conversions | P4 | PRI/SCN macros and strtoimax preserve the 64-bit boundary. |
| B08 | &lt;iso646.h&gt; · alternative operators | P4 | and, or, and not expand to their operators and preserve precedence. |
| B09 | &lt;limits.h&gt; · integer limits | P2→P4 | CHAR_BIT==8 and exact LONG_MAX; constants have the correct types. |
| B10 | &lt;locale.h&gt; · virtual locales | Unplanned | setlocale/localeconv and configurable locales; their integration with `<ctype.h>` and `<string.h>` is also deferred. Existing coverage under the C locale is retained. |
| B11 | &lt;math.h&gt; · real floating-point families and classification | P2→P6 · real-valued function set implemented in the profile | The function set includes the `float`, `double`, and `long double` variants, including integer-return and output-parameter functions, plus `fma`/`fmaf`/`fmal`, classification and comparison macros, `float_t`/`double_t`, and required constants. `math_errhandling` is `MATH_ERRNO`: domain errors set `EDOM`; pole and range errors set `ERANGE`; successful calls preserve `errno`. C11 leaves whether underflow sets `errno` to the implementation; this profile preserves it for exact zero and subnormal results and does not claim Annex F underflow behavior. Floating-point exception flags and `<fenv.h>` remain `Unplanned`; optional fast-FMA macros are not advertised, and Annex F remains a separate optional evaluation with no implementation commitment. |
| B12 | &lt;setjmp.h&gt; · nonlocal jump | Unplanned | setjmp returns 0; longjmp returns with 7 and restores the valid frame. |
| B13 | &lt;signal.h&gt; · virtual signals | Unplanned | signal registers a handler; raise invokes it; abnormal termination is identified. |
| B14 | &lt;stdalign.h&gt; · alignment macros | P5 partial | `alignas`/`alignof` alias `_Alignas`/`_Alignof`; availability macros are 1. |
| B15 | &lt;stdarg.h&gt; · varargs traversal | P4 | va_copy keeps an independent traversal, and va_end closes both. |
| B16 | &lt;stdatomic.h&gt; · operations and fences | Unplanned | Atomic library operations and fences; runtime ordering depends on Unplanned virtual concurrency. |
| B17 | &lt;stdbool.h&gt; · Boolean macros | P2→P4 | bool b=9 normalizes to 1; true/false and availability macro are correct. |
| B18 | &lt;stddef.h&gt; · types, NULL, and offsetof | P3→P5 partial | Provides `NULL`, `size_t`, `ptrdiff_t`, `offsetof` for members and constant subscripts, and profile-aligned `max_align_t`; the rest of the family remains partial. |
| B19 | &lt;stdint.h&gt; · exact/least/fast types and limits | P2→P4 | int64_t and UINT64_C are exact; intptr_t represents the virtual address. |
| B20 | &lt;stdio.h&gt; · FILE, formats, buffers, and virtual files | P4→P5 partial | The 45 narrow functions from `CAPABILITIES.stdioFunctions`; virtual files only, temporary files removed on close/termination, `fpos_t` as a `long` byte offset, `freopen` retains `FILE *` identity. For `freopen(NULL, mode, stream)`, this profile closes the previous stream, returns `NULL`, and sets `EINVAL` without reconfiguring it; C11 allows an implementation to provide no change when `filename` is null (N1570 §7.21.5.4p3–5). Streams default to `_IONBF`; `setvbuf` supports `_IOFBF`, `_IOLBF`, and `_IONBF` before a stream operation, validates a non-null buffer range but uses an engine-owned queue, and requires positive capacity for buffered modes. Flush occurs on capacity, line-buffered newline or stdin read, `fflush`, close, repositioning, and normal return/`exit` after `atexit` handlers; quick termination, abort, runtime errors, and cancellation do not auto-flush. Decimal floating precision is bounded by the existing I/O and work budgets; `%a`/`%A` precision is capped at 100000 hexadecimal digits. Wide `%lc`, `%ls`, and `%l[` are `Unplanned`. |
| B21 | &lt;stdlib.h&gt; · memory, conversion, sort, RNG, and environment | P3→P5 partial | Integer/floating-point conversions, allocation, search/sort, RNG, termination, and empty virtual environment. `aligned_alloc` accepts power-of-two alignments up to 65536 bytes and requires a multiple-sized allocation; arguments outside the profile return `NULL`/`EINVAL`. C locale: `MB_CUR_MAX=1`, `mblen` accepts one-byte ASCII; `system(NULL)=0`, and commands fail with `ENOSYS`. Conversions depending on `wchar_t` are `Unplanned`. |
| B22 | &lt;stdnoreturn.h&gt; · noreturn macro | Unplanned | The header and its macro are deferred; the `_Noreturn` keyword is already implemented in the language. |
| B23 | &lt;string.h&gt; · bytes, strings, and collation | P4 | Retains functions already available under the C locale; integration with configurable locales remains `Unplanned` alongside B10. |
| B24 | &lt;tgmath.h&gt; · type-generic math selection | Unplanned | Type-generic selection for real and complex math; depends on the unplanned complex header and relevant library APIs. |
| B25 | &lt;threads.h&gt; · threads, mutex, condition, and TSS | Unplanned | Virtual threads, join, mutexes, conditions, `call_once`, and TSS; depends on Unplanned virtual concurrency. |
| B26 | &lt;time.h&gt; · clock and calendar | P5 partial | Ten C11 functions with a UTC calendar; the core uses the fixed instant `2024-01-01T00:00:00Z` by default and accepts an epoch-millisecond provider per session. Run and debug inject `Date.now` from their Workers. `time_t`/`clock_t` are LP64 `long`, `time()` uses seconds, `timespec_get()` reflects the provider's millisecond resolution, `localtime` equals `gmtime`, and buffers are static per execution. |
| B27 | &lt;uchar.h&gt; · char16_t/char32_t conversions | Unplanned | mbrtoc16/32 and c16/32rtomb with mbstate; invalid sequence diagnosed. |
| B28 | &lt;wchar.h&gt; · wide text, streams, and multibyte | Unplanned | The header is not published and `wchar_t` is not provided: `wint_t`, `WEOF`, wide streams, multibyte conversions, and the other APIs in this family are out of scope. |
| B29 | &lt;wctype.h&gt; · wide classification | Unplanned | wctype/wctrans, iswalpha, and towupper according to the selected locale. |

### Optional Extension

| ID | Area and scope | Phase | Proposed minimal acceptance |
| --- | --- | --- | --- |
| O01 | Annex K · bounds-checking interfaces and constraint handlers | Optional evaluation | Annex K may be evaluated separately; there is no implementation commitment, and any future implementation would need consistent contracts, failures, `__STDC_LIB_EXT1__`, and opt-in behavior. |

## Unplanned

These deferred entries remain visible in the matrix to document the standard inventory and its status; no target phase is assigned to them. Wide conversions from `<stdio.h>` and `<stdlib.h>` are also out of scope. `<ctype.h>` and `<string.h>` retain their support under the C locale, and `_Noreturn` remains supported by the language.

| Deferred block | Matrix | Deferred scope |
| --- | --- | --- |
| `<fenv.h>` | B05 | Floating-point environment API. |
| `<locale.h>` and locale integration in `<ctype.h>`/`<string.h>` | B10, B03, B23 | Configurable locales and their integration with classification, transformation, and collation; existing behavior under the C locale is retained. |
| `<complex.h>` | B02 | Complex library macros and functions. |
| Complex and imaginary language support | L34 | `_Complex` types and arithmetic; `_Imaginary` types and arithmetic. |
| `<setjmp.h>` | B12 | Nonlocal jumps. |
| `<signal.h>` | B13 | Virtual signals. |
| `_Atomic` language support and concurrent memory model | L35 | `_Atomic` types and operations and memory ordering; depend on Unplanned virtual concurrency. |
| `<stdatomic.h>` | B16 | Atomic library operations and fences; runtime memory ordering depends on virtual concurrency. |
| `<stdnoreturn.h>` | B22 | The header and its macro; the `_Noreturn` keyword is already implemented. |
| `<tgmath.h>` | B24 | Type-generic math selection over real and complex library functions. |
| `<threads.h>` | B25 | Virtual threads, synchronization, and thread-specific storage. |
| `<uchar.h>` | B27 | Conversions among multibyte characters, `char16_t`, and `char32_t`. |
| Wide-character family (`<wchar.h>`, `<stdio.h>`, and `<stdlib.h>`) | B20, B21, B28 | `wchar_t` is not provided, and `%lc`, `%ls`, and `%l[` are not implemented; wide `stdio` formats produce an explicit diagnostic. `mbtowc`, `wctomb`, `mbstowcs`, and `wcstombs` are also deferred, along with `wint_t`, `WEOF`, wide streams, and the other wide-character APIs. |
| `<wctype.h>` | B29 | Wide-character classification and transformations. |
| Virtual concurrency and scheduler | L35, B16, B25 | Concurrent execution, scheduling, and race behavior; prerequisite for runtime atomic operations, cross-thread TLS independence, and per-thread `errno`. |

## Capabilities and Validation

P6 covers runtime `sizeof` for variable-length arrays and the real-valued C11 `math.h` function set for `float`, `double`, and `long double`, including classification/comparison macros, constants, output parameters, integer-return variants, and `MATH_ERRNO` reporting. The differential fixtures cover captured and nested VLA bounds, VLA type names and typedefs, pointer-to-VLA stride and operand effects, adjusted array parameters, and active-VLA debug inspection. Math fixtures check result types, output values, finite cases, binary80-only range and exact subnormal behavior, domain/pole/range reporting, comparison-macro evaluation, and fused multiply-add cases that distinguish one final rounding from intermediate rounding; GCC and Clang serve as native oracles. Floating-point exception flags and `<fenv.h>` remain `Unplanned`. Complex language support (`_Complex` and `_Imaginary`), atomic language support (`_Atomic`), `<complex.h>`, `<stdatomic.h>`, `<tgmath.h>`, `<threads.h>`, and virtual concurrency are `Unplanned`. `__STDC_NO_VLA__` is not defined for this profile; `__STDC_NO_COMPLEX__`, `__STDC_NO_ATOMICS__`, and `__STDC_NO_THREADS__` remain defined as `1`. C11 defines no `__STDC_NO_IMAGINARY__` macro. `_Thread_local` remains implemented with one instance per session; TLS independence across threads and per-thread `errno` depend on Unplanned virtual concurrency and `<threads.h>`. Annexes F, G, and K may be evaluated separately; these optional evaluations carry no implementation commitment. The published coverage does not claim hosted/freestanding or complete C11 conformance. [WG14 N1570, §6.10.8.3 and Annexes F/G/K](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf).

A row is complete only when it covers its entire family, dependencies, edge cases, and diagnostics, not just when it passes the table's example. Maintain project-specific unit and differential tests against GCC/Clang with `-std=c11 -pedantic-errors`; use examples without UB and avoid requiring equality where C permits multiple orders or results. GCC distinguishes its GNU dialect from the selected standard. [GCC Standards](https://gcc.gnu.org/onlinedocs/gcc/Standards.html).

Add tests for numeric boundaries, memory/lifetime, provenance, limits, cancellation, and resets between sessions; each phase must be tested in the browser and Node. Coverage, profile, and validation results will have a public version. “Complete C11” will be reserved for sufficient coverage and validation.
