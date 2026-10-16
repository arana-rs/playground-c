import type { DebugSessionOptions } from '@playground/c11-engine/core';
import { DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS } from '@playground/c11-engine/core';
import type { RunOptions } from '@playground/c11-engine/browser';

export interface RunConfiguration {
  /** Active wall time for worker startup, preparation and execution, excluding user waits. */
  timeoutMs: number;
  options: Omit<RunOptions, 'signal'>;
  debug: DebugSessionOptions;
  memoryViewer: {
    historySteps: number;
    playIntervalMs: number;
  };
}

/** Shared execution budgets for normal Run and the Memory Viewer. */
export const RUN_CONFIGURATION: RunConfiguration = {
  timeoutMs: 10_000,
  options: {
    prepare: { limits: { maxSourceChars: 100_000, maxTokens: 25_000, maxPreprocessSteps: 1_000_000, maxDepth: 128 } },
    execute: { limits: { maxInstructions: 100_000, maxMemoryBytes: 1_048_576, maxIOBytes: 1_048_576, maxDepth: 128 } },
  },
  debug: {
    maxEvents: 100_000,
    maxObjects: 64,
    maxElementsPerArray: DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS.maxElementsPerArray,
    maxValueChars: 64,
  },
  memoryViewer: { historySteps: 10_000, playIntervalMs: 500 },
};
