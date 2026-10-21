# Debugging and Memory Viewer

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

`inspectHeapObjects()` returns only live blocks obtained with `malloc` or `realloc`. Each snapshot uses the current allocation's `id`/`allocationId` and address, retains its requested size in bytes, and keeps the opaque `heap` provenance; it does not invent a C type, name, or value. A successful reallocation copies the first `min(old size, new size)` bytes and creates a new object identity, even if it retains the address. `free` and `realloc(p, 0)` immediately remove the block from the view and release its interval; a failed nonzero-size allocation returns `NULL` and preserves the entire previous block. Addresses of other live blocks do not change. Heap placement prefers pseudorandom bases in a compact prefix growing from `0x30000`; it leaves room for up to two additional 16-byte slots as the occupied extent grows, so a later allocation can appear before, after, or between live blocks. If that compact prefix cannot fit a request, bounded probes and a scan of the full `[0x30000, 0x40000)` arena preserve its full capacity. The allocator stores extents per live block, not per reserved byte. `CAPABILITIES.virtualMemory.heapAddressRange` publishes the base, exclusive end, nominal capacity, alignment, guard, and the fact that randomization is not cryptographic. `debugOptions.heapAddressSeed`, a 32-bit integer, makes the sequence reproducible only for debug sessions; without a seed, the allocator uses the RNG available in the runtime. `malloc(0)`, `realloc(NULL, 0)`, and `realloc(p, 0)` leave no live blocks. A new call returns current DTOs; snapshots saved by the consumer can display earlier pauses.

Integer and enum values are shown in exact decimal; `_Bool` as `0` or `1`; `char` as a quoted literal with C escapes (for example, `'C'` or `'\n'`); `float` and `double` use the shortest decimal that round-trips to the same value, and `long double` displays its exact binary80 value in hexadecimal. `-0`, `nan`, `inf`, and `-inf` are preserved. Values from scalar inspectors and `inspectStaticObjects()` are complete; the interface decides whether to shorten their display. `inspectArrays()` elements may be truncated according to `maxValueChars`, and `valueTruncated` indicates when that happens.

Inspection is available before the first `resume()`, while paused, and after a terminal result. After normal termination, scopes have already closed and it returns `[]`; after an error or limit, it retains only objects that were still live when the VM stopped. It does not force unwinding or add history state. Each call captures current values, so a consumer that needs history must save the DTOs from each pause.

Object events describe a memory root: `objectId` and `allocationId` have the same allocation ID, `duration` distinguishes `automatic`, `static`, `thread-local`, `heap`, and `compound-literal`, and `origin` distinguishes `variable`, `parameter`, `compound-literal`, `heap`, and `string-literal`. They may include `name`; they also carry a textual `typeSummary`, `addressVirtual` as `bigint`, and `size` in bytes. Automatic variables and automatic compound literals carry the frame and scope IDs that own their duration. Heap, static, thread-local, and string literal objects have `null` in both fields, including when a heap object is removed with `free`. Global and local `static` variables, TLS, arrays, and structs are reported as one root object; their members, elements, and subobjects do not create nodes. Observing events does not read C values, materialize members, or change the state of uninitialized objects.

Automatic objects are reported when their declarations execute, and parameters on function entry. The VM internally reserves local cells on scope entry; that reservation does not create an early event. Deletion is emitted only for an `allocationId` that already had an `object-create`. The API also reports static objects when first initialized, observable C string literals, and successful heap blocks from `malloc`/`realloc`; `free` and successful reallocation emit the corresponding deletion events if the previous block was tracked. Global objects may emit events during session construction; local `static` objects are created when the VM first reaches their declaration scope. Thus, a local `static` in a function or block that is never reached produces no event. The API reports allocations made by the VM and does not preallocate objects just for debugging. `free(NULL)`, `realloc(NULL, 0)`, `realloc(p, 0)`, invalid frees, and failed allocations do not produce creation events; invalidating a tracked heap block does publish its deletion. Static objects and string literals persist without a synthetic deletion when the program ends. Implementation support objects for `errno`, stdio, `argv`, or variadic functions are not exposed.

`DebugSessionOptions.maxEvents` limits the session's total committed events (100,000 by default), even if the queue is drained. `heapAddressSeed` controls reproducible heap randomization for tests and debugging. `maxObjects` (1,000 by default) limits the roots returned by each bounded inspector (`inspectArrays` and `inspectAggregates`); `omittedObjects` counts those excluded by this budget. `maxElementsPerArray` (10 by default) limits the cells inspected per root and includes NUL and padding zeros; pointer arrays have a hard limit of 10 even if a larger arithmetic-cell limit is configured. `maxValueChars` (256 by default) limits arithmetic array-cell `displayValue` strings, and `valueTruncated` indicates whether one was shortened; pointer values remain complete. Struct members use the fixed `DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers` limit (10) and complete values. The engine exports `DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS` and `DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS`; a host can derive common budgets from them and pass its settings through `debugOptions`. The event budget is reserved before an instrumented operation; if no space remains, `resume()` returns `kind: 'debug-limit'`, `resource: 'maxDebugEvents'`, the limit, a diagnostic, and metrics. The consumer can drain the complete prefix that was emitted; the session stops without silently truncating it or inventing scope/frame exits. An execution limit or error does not force unwinding either. The debug budget is independent of `maxMemoryBytes`; events consume history memory only in debug sessions, while inspectors are generated on demand and do not count as events. The core Debug API does not retain write snapshots or implement history/reverse execution; the application stores its own Memory Viewer history below. A normally closed block reports the location of the `}` token retained by the parser; scopes closed by `return` or a jump use the location of that transition. `frame-enter` uses the function declaration, and `frame-exit` uses the explicit `return` or, on fallthrough, the body's closing brace.

### Application Memory Viewer

After each `resume()`, the application captures inspector results and stores immutable snapshots per line visit for Previous/Next. Navigation changes the displayed snapshot only; it does not rewind or rerun the VM. Multiple writes on one C line appear as that visit's final state. Delta markers compare initialization and displayed value; pointer deltas also compare status and target identity/offset.

Arrays show actual one-dimensional cells, including a real NUL when present, and never invent a terminator. The viewer caps arrays at 10 cells, shows “Maximum 10 elements” beyond that, and uses a fallback for matrices. Structs show up to 10 direct members; nested arrays/aggregates remain placeholders, and unions or larger structs use one placeholder. These visual limits do not limit C execution. Minimal shows field names and aliases, reveals indices on pointer hover or keyboard focus, and renders uninitialized values as —. Normal and Debug keep indices visible, label uninitialized values, and show member addresses, types, sizes, offsets, and labeled padding ranges.

Pointer hover or keyboard focus links only a visible target with matching allocation identity, exact byte offset, and type. One-past, dangling, misaligned, placeholder, and function-pointer targets are not linked, and the viewer does not traverse pointer graphs. A typed heap view replaces raw bytes only when it covers the whole allocation; partial views leave the raw allocation visible.

Heap cards use a `*pointer` label when a currently live, initialized pointer variable, pointer-array cell, or named pointer member targets the allocation root through an available C path; multiple aliases are shown in a stable comma-separated list. A path seen with different destinations, including null, interior, one-past, dangling, or uninitialized bindings, is omitted and uses the generic heap label. Stale allocation identities do not label a block, and typed heap aggregate cards use the same allocation-root aliases.

At each selected history point, the application derives one additional Heap card from the latest `object-delete` event with heap duration in that point's lifecycle prefix. It shows the event's allocation ID, address, and size with `Freed`, without inspecting the released memory. A later heap deletion replaces that card; all live blocks remain visible, including a new allocation at the same address under a different allocation ID. Previous and Next select the corresponding event prefix, and a new debug session starts without a released card. `free(NULL)` emits no deletion and therefore does not replace the card. Successful `realloc` deletes the old identity before publishing the new one, so the old block is the released card while the new block remains live; `realloc(p, 0)` publishes only the deletion, while `realloc(NULL, size)` publishes only a new allocation.

The Memory Viewer stores a lightweight console checkpoint with each displayed VM step. Previous and Next project the ordered stdout, stderr, stdin echo, and EOF transcript through the selected checkpoint; browsing history does not rerun the VM or resend input. Adjacent output chunks are coalesced in the application journal, while checkpoints retain the earlier tail length so later output cannot leak into an earlier frame.

The Memory Viewer playback speed is a persisted application preference with fixed delays of 100, 250, 500, 1000, or 2000 ms per displayed step. The default remains `RUN_CONFIGURATION.memoryViewer.playIntervalMs` (500 ms). Changing speed during playback leaves the already scheduled tick in place and uses the new delay when the controller schedules the following tick; the recursive timer still allows only one pending tick and one VM step at a time. This preference changes playback cadence only and does not change VM execution budgets or Run/Stop behavior.

The Memory Viewer I/O checkbox controls console capture as well as console visibility. While it is off, the controller skips output decoding and transcript storage, and the Worker advances its output offsets without publishing output events or copying output deltas. Stdin still starts empty and open; if the program requests input while I/O is off, the controller sends EOF so execution can continue under the existing interactive-stdin contract. Turning I/O on starts capture from that point. Output produced while it was off is discarded and cannot be recovered by enabling the checkbox after execution ends; toggling the checkbox does not restart or rerun the session. These application settings do not change the engine's raw output bytes or budgets.

### Console terminal controls

Run and Memory Viewer share a presentation-only text screen for program output. Streaming stdout and stderr use one cursor in Worker event order; stderr cells retain their stream identity and use a distinct style without adding display columns. When only separate result byte arrays are available, the UI presents stdout before stderr because the result carries no cross-stream order. The engine's returned stdout/stderr byte arrays and the Memory Viewer transcript remain unchanged by this presentation.

The console handles carriage return (`\r`), backspace (`\b`), line feed, and tabs. Carriage return moves to column zero and later characters overwrite existing cells; backspace moves left without erasing. Line feed starts a new display line and resets the column. Tabs advance to the next eight-column stop. It also handles CSI `K` and `J` modes 0, 1, and 2, and cursor positioning with `H`/`f`; omitted or zero row/column parameters for `H`/`f` use row 1, column 1. `CSI 2J` clears the displayed screen while preserving the cursor; `CSI H` moves it to the upper left.

The parser is not a complete terminal emulator. It does not apply color/style CSI commands, terminal modes, or other cursor motions. Unsupported complete escape sequences are consumed without changing the screen, and printable text after them remains visible. An incomplete escape sequence is held until more program output arrives and is discarded when the transcript resets. CSI parameter strings longer than 32 characters are ignored; `H`/`f` coordinates are clamped to 1,000. Ordinary program text is not truncated. Unicode cursor positions count code points rather than terminal display cells. Stdin echo is inserted literally and is never parsed as an output escape sequence. Application diagnostics and status remain outside the virtual screen so a clear command cannot remove them.
