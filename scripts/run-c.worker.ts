import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { createExecutionSession, prepare } from '@playground/c11-engine/core';
import type { ExecutionSession } from '@playground/c11-engine/core';
import type { RunCliEngineResult, RunCliWorkerData, RunCliWorkerMessage, RunCliWorkerRequest } from './run-c.protocol.ts';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';

const port = parentPort;
if (!port) throw new Error('run-c worker requires a parent port.');

const { filePath } = workerData as RunCliWorkerData;
let session: ExecutionSession | undefined;
let waitingForInput = false;
let stdinEnded = false;
let terminal = false;

function post(message: RunCliWorkerMessage): void {
  port!.postMessage(message);
}

function fail(message: string): void {
  if (terminal) return;
  terminal = true;
  post({ type: 'worker-error', message });
  port!.close();
}

function finish(result: RunCliEngineResult): void {
  if (terminal) return;
  terminal = true;
  post({ type: 'result', result });
  port!.close();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resume(): void {
  if (!session || terminal) return;
  const progress = session.resume();
  if (progress.kind === 'input-needed') {
    waitingForInput = true;
    post({ type: 'input-needed', stdout: progress.stdout, stderr: progress.stderr });
  } else {
    finish(progress);
  }
}

port.on('message', (request: RunCliWorkerRequest) => {
  if (request?.type !== 'stdin' || !waitingForInput || !session || terminal) return;
  waitingForInput = false;
  try {
    if (request.bytes.byteLength > 0) session.appendStdin(request.bytes);
    if (request.end && !stdinEnded) {
      stdinEnded = true;
      session.endStdin();
    }
    resume();
  } catch (error) {
    fail(describeError(error));
  }
});

async function start(): Promise<void> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    fail('Se requiere una ruta de archivo.');
    return;
  }

  let source: string;
  try {
    source = await readFile(filePath, { encoding: 'utf8' });
  } catch (error) {
    terminal = true;
    post({ type: 'read-error', message: describeError(error) });
    port!.close();
    return;
  }

  const preparation = prepare(
    { entry: 'main.c', files: [{ name: 'main.c', source }] },
    RUN_CONFIGURATION.options.prepare,
  );
  if (preparation.kind !== 'prepared') {
    finish(preparation);
    return;
  }

  session = createExecutionSession(preparation.program, RUN_CONFIGURATION.options.execute);
  resume();
}

void start().catch((error: unknown) => fail(describeError(error)));
