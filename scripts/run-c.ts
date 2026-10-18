import { Worker } from 'node:worker_threads';
import type { RunCliWorkerData, RunCliWorkerMessage, RunCliWorkerRequest } from './run-c.protocol.ts';
import { formatDiagnosticLocation } from '../src/execution/diagnosticFormatting.ts';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';

const USAGE = 'Usage: pnpm run-c <file.c>\n     pnpm run-c -- --help\n';
const workerData: RunCliWorkerData | undefined = parseArguments(process.argv.slice(2));

function parseArguments(args: string[]): RunCliWorkerData | undefined {
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${USAGE}\nRun a C source file with the project engine. The virtual input file is named main.c.\n`);
    process.exitCode = 0;
    return undefined;
  }
  if (args.length !== 1 || args[0].length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return undefined;
  }
  return { filePath: args[0] };
}

function formatDiagnostic(diagnostic: { file: string; line: number; column: number; code: string; message: string }): string {
  return `${formatDiagnosticLocation(diagnostic)}: ${diagnostic.code}: ${diagnostic.message}\n`;
}

if (workerData) runFile(workerData);

function runFile(data: RunCliWorkerData): void {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./run-c.worker.ts', import.meta.url), { workerData: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-c: could not start execution: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  const stdin = process.stdin;
  const maxIOBytes = RUN_CONFIGURATION.options.execute?.limits?.maxIOBytes;
  const maxQueuedBytes = maxIOBytes === undefined || maxIOBytes === null
    ? Number.MAX_SAFE_INTEGER
    : maxIOBytes + 1;
  const inputQueue: Buffer[] = [];
  let queuedBytes = 0;
  let stdinEnded = false;
  let awaitingInput = false;
  let done = false;
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let watchdog: NodeJS.Timeout | undefined;
  let activeStartedAt: number | undefined;
  let activeElapsedMs = 0;

  function writeDelta(stream: NodeJS.WriteStream, snapshot: Uint8Array, offset: number): number {
    if (snapshot.byteLength < offset) offset = 0;
    if (snapshot.byteLength > offset) {
      stream.write(Buffer.from(snapshot.buffer, snapshot.byteOffset + offset, snapshot.byteLength - offset));
      offset = snapshot.byteLength;
    }
    return offset;
  }

  function writeOutput(stdout: Uint8Array | undefined, stderr: Uint8Array | undefined): void {
    if (stdout) stdoutOffset = writeDelta(process.stdout, stdout, stdoutOffset);
    if (stderr) stderrOffset = writeDelta(process.stderr, stderr, stderrOffset);
  }

  function clearWatchdog(): void {
    if (activeStartedAt !== undefined) {
      activeElapsedMs += performance.now() - activeStartedAt;
      activeStartedAt = undefined;
    }
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  }

  function startWatchdog(): void {
    if (done || activeStartedAt !== undefined) return;
    const remaining = RUN_CONFIGURATION.timeoutMs - activeElapsedMs;
    if (remaining <= 0) {
      onTimeout();
      return;
    }
    activeStartedAt = performance.now();
    watchdog = setTimeout(onTimeout, remaining);
  }

  function cleanUpInput(): void {
    stdin.pause();
    stdin.off('data', onStdinData);
    stdin.off('end', onStdinEnd);
    stdin.off('error', onStdinError);
  }

  function finish(code: number, message?: string, terminateWorker = true): void {
    if (done) return;
    done = true;
    clearWatchdog();
    cleanUpInput();
    process.off('SIGINT', onSigint);
    if (message) process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
    process.exitCode = code;
    if (terminateWorker) void worker.terminate();
  }

  function onTimeout(): void {
    const timeout = RUN_CONFIGURATION.timeoutMs;
    finish(1, `run-c: execution exceeded ${timeout} ms of active time.`);
  }

  function sendQueuedInput(): void {
    if (done || !awaitingInput || (queuedBytes === 0 && !stdinEnded)) return;
    awaitingInput = false;
    const bytes = queuedBytes === 0 ? new Uint8Array() : Buffer.concat(inputQueue, queuedBytes);
    inputQueue.length = 0;
    queuedBytes = 0;
    if (!stdinEnded) stdin.resume();
    startWatchdog();
    const request: RunCliWorkerRequest = { type: 'stdin', bytes, end: stdinEnded };
    worker.postMessage(request);
  }

  function onStdinData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, maxQueuedBytes - queuedBytes);
    const accepted = bytes.subarray(0, remaining);
    if (accepted.byteLength > 0) {
      if (inputQueue.length >= 64) {
        const combined = Buffer.concat(inputQueue, queuedBytes);
        inputQueue.splice(0, inputQueue.length, combined);
      }
      inputQueue.push(Buffer.from(accepted));
      queuedBytes += accepted.byteLength;
    }
    if (queuedBytes >= maxQueuedBytes && !stdinEnded) stdin.pause();
    sendQueuedInput();
  }

  function onStdinEnd(): void {
    stdinEnded = true;
    sendQueuedInput();
  }

  function onStdinError(error: Error): void {
    finish(1, `run-c: failed to read stdin: ${error.message}`);
  }

  function onSigint(): void {
    finish(130);
  }

  function onMessage(message: RunCliWorkerMessage): void {
    if (done) return;
    if (message.type === 'input-needed') {
      writeOutput(message.stdout, message.stderr);
      awaitingInput = true;
      clearWatchdog();
      sendQueuedInput();
      return;
    }
    if (message.type === 'read-error') {
      finish(1, `run-c: could not read ${JSON.stringify(data.filePath)}: ${message.message}`);
      return;
    }
    if (message.type === 'worker-error') {
      finish(1, `run-c: ${message.message}`);
      return;
    }

    const result = message.result;
    writeOutput('stdout' in result ? result.stdout : undefined, 'stderr' in result ? result.stderr : undefined);
    if (result.kind === 'terminated') {
      finish(result.exitCode, undefined, false);
      return;
    }
    for (const diagnostic of result.diagnostics) process.stderr.write(formatDiagnostic(diagnostic));
    finish(1, undefined, false);
  }

  stdin.on('data', onStdinData);
  stdin.on('end', onStdinEnd);
  stdin.on('error', onStdinError);
  process.on('SIGINT', onSigint);
  startWatchdog();
  stdin.resume();

  worker.on('message', onMessage);
  worker.on('error', (error: Error) => finish(1, `run-c: could not start execution: ${error.message}`));
  worker.on('exit', (code: number) => {
    if (!done) finish(1, `run-c: worker exited unexpectedly (code ${code}).`, false);
  });
}
