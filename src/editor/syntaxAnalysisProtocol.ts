import type { PrepareOptions, SyntaxAnalysisResult } from '@playground/c11-engine/core';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';

export interface SyntaxAnalysisRequest {
  type: 'analyze';
  jobId: number;
  snapshot: WorkspaceSourceSnapshot;
  options: PrepareOptions;
}

export type SyntaxAnalysisResponse =
  | { type: 'result'; jobId: number; result: SyntaxAnalysisResult }
  | { type: 'error'; jobId: number; message: string };
