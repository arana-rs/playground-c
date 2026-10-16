import type { ExecuteProgress, ExecuteResult, PrepareResult } from '@playground/c11-engine/core';

export interface RunCliWorkerData {
  readonly filePath: string;
}

export type RunCliEngineResult = Exclude<PrepareResult, { kind: 'prepared' }> | ExecuteResult;

export type RunCliWorkerMessage =
  | { readonly type: 'input-needed'; readonly stdout: Uint8Array; readonly stderr: Uint8Array }
  | { readonly type: 'result'; readonly result: RunCliEngineResult }
  | { readonly type: 'read-error'; readonly message: string }
  | { readonly type: 'worker-error'; readonly message: string };

export interface RunCliWorkerRequest {
  readonly type: 'stdin';
  readonly bytes: Uint8Array;
  readonly end: boolean;
}
