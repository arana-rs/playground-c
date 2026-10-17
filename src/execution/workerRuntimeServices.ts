import type { ExecutionRuntimeServices } from '@playground/c11-engine/core';

/** Create per-session host services inside a Worker, never inside serializable RunOptions. */
export function createWorkerRuntimeServices(nowMilliseconds: () => number = Date.now): ExecutionRuntimeServices {
  return {
    wallClock: {
      nowEpochMilliseconds: () => BigInt(nowMilliseconds()),
    },
  };
}
