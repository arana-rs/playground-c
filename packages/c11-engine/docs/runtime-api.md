# Runtime API

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

Adapter readMs includes reading/decoding input; prepareMs and executeMs measure preparation and execution; totalMs covers the adapter call. Worker startup, messaging, and termination are outside those adapter timings.

The browser app takes its budgets from `RUN_CONFIGURATION`: 100,000 source characters, 25,000 tokens, 1,000,000 preprocessing steps, depth 128 per stage, 100,000 instructions, 1 MiB each for C memory and virtual I/O, and a 10-second active watchdog. The Execution limits control lets the user change depth and instruction budgets; its initial values come from `RUN_CONFIGURATION`, and saved values apply to the next Run or Memory Viewer session. All other UI budgets remain fixed at their `RUN_CONFIGURATION` values. These UI values differ from the core defaults below. Run and Memory Viewer execute in Workers; Stop and watchdog expiry terminate the Worker. The watchdog pauses while interactive stdin is waiting. The Node adapter does not create a Worker.

`prepare` returns `prepared`, `prepare-error`, or `limit`. `execute` returns `terminated`, `runtime-error`, or `limit`. Errors include diagnostics with a `code`, message, file, line, and column; only `terminated` has an `exitCode`. Partial output bytes are preserved in execution results that end with an error or limit.

When `main` returns normally, the Linux profile exposes an `exitCode` from 0 through 255 and retains the original status: returning 256 yields `mainReturn: 256`, `rawExitStatus: 256`, and `exitCode: 0`. `exit(status)` runs `atexit` handlers in LIFO order; `quick_exit(status)` runs only `at_quick_exit` handlers, also in LIFO order. `_Exit(status)` and `abort()` terminate without running those handlers; `abort()` uses the profiled status 134. Explicit termination does not invent a return from `main`. Errors, limits, and cancellation do not fabricate a successful exit code. Signals and `<signal.h>` remain `Unplanned`. See [Linux exit(3)](https://man7.org/linux/man-pages/man3/exit.3.html).

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
