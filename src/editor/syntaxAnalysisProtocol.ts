import type { PrepareOptions, SyntaxAnalysisResult } from '@playground/c11-engine/core';

export interface SyntaxAnalysisRequest {
  type: 'analyze';
  jobId: number;
  source: string;
  options: PrepareOptions;
}

export type SyntaxAnalysisResponse =
  | { type: 'result'; jobId: number; result: SyntaxAnalysisResult }
  | { type: 'error'; jobId: number; message: string };
