import { analyzeSyntax } from '@playground/c11-engine/core';
import type { SourceProject } from '@playground/c11-engine/core';
import type { SyntaxAnalysisRequest, SyntaxAnalysisResponse } from './syntaxAnalysisProtocol.ts';

export function analyzeSyntaxRequest(request: SyntaxAnalysisRequest): SyntaxAnalysisResponse {
  try {
    const project: SourceProject = {
      entry: 'main.c',
      files: [{ name: 'main.c', source: request.source }],
    };
    return {
      type: 'result',
      jobId: request.jobId,
      result: analyzeSyntax(project, request.options),
    };
  } catch (error) {
    return {
      type: 'error',
      jobId: request.jobId,
      message: error instanceof Error ? error.message : 'Could not analyze C syntax.',
    };
  }
}
