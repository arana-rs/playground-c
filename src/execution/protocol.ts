import type { RunOptions, RunResult } from '@playground/c11-engine/browser';
import type { RunWorkerProgress } from './diagnostics.ts';

/** The parent owns cancellation and the worker owns preparation/execution. */
export interface RunRequest {
  type: 'run';
  jobId: number;
  file: File;
  options: Omit<RunOptions, 'signal'>;
}

export type WorkerCommand =
  | RunRequest
  | { type: 'stdin'; jobId: number; requestId: number; bytes: Uint8Array }
  | { type: 'stdin-eof'; jobId: number; requestId: number };

export type RunResponse =
  | { type: 'output'; jobId: number; sequence: number; stream: 'stdout' | 'stderr'; chunk: Uint8Array }
  | { type: 'progress'; jobId: number; progress: RunWorkerProgress }
  | { type: 'input-needed'; jobId: number; requestId: number; progress: RunWorkerProgress }
  | { type: 'result'; jobId: number; result: RunResult }
  | { type: 'error'; jobId: number; phase: 'startup' | 'run'; message: string };
