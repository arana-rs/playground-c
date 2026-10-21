import { analyzeSyntax } from '@playground/c11-engine/core';
import type { Diagnostic, EngineMetrics, SyntaxAnalysisResult } from '@playground/c11-engine/core';
import { createBuildPlanProject, resolveBuildPlan } from '../build/buildPlan.ts';
import type { SyntaxAnalysisRequest, SyntaxAnalysisResponse } from './syntaxAnalysisProtocol.ts';

const emptyMetrics = (): EngineMetrics => ({
  prepareMs: 0,
  executeMs: 0,
  sourceChars: 0,
  tokenCount: 0,
  preprocessSteps: 0,
  instructionCount: 0,
  peakMemoryBytes: 0,
});

function buildPlanResult(diagnostics: readonly Diagnostic[]): SyntaxAnalysisResult {
  return {
    kind: 'error',
    diagnostics,
    truncated: false,
    metrics: emptyMetrics(),
  };
}

export function analyzeSyntaxRequest(request: SyntaxAnalysisRequest): SyntaxAnalysisResponse {
  try {
    const resolution = resolveBuildPlan(request.snapshot.files, request.snapshot.fileName);
    const project = createBuildPlanProject(request.snapshot.files, resolution);
    return {
      type: 'result',
      jobId: request.jobId,
      result: project
        ? analyzeSyntax(project, request.options)
        : buildPlanResult(resolution.diagnostics),
    };
  } catch (error) {
    return {
      type: 'error',
      jobId: request.jobId,
      message: error instanceof Error ? error.message : 'Could not analyze C syntax.',
    };
  }
}
