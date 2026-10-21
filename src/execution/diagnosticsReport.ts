import type { RunDiagnosticsReport } from './diagnostics.ts';

export interface TimeoutBrowserContext {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number | null;
  visibilityState: string | null;
  secureContext: boolean | null;
}

const REPORT_FORMAT_VERSION = 1;

/** Capture only the small set of browser details useful for reproducing a timeout. */
export function readTimeoutBrowserContext(): TimeoutBrowserContext {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const userAgent = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  const platform = typeof nav?.platform === 'string' ? nav.platform : '';
  const visibilityState = typeof document === 'undefined' ? null : document.visibilityState;
  const hardwareConcurrency = nav && Number.isFinite(nav.hardwareConcurrency)
    ? nav.hardwareConcurrency
    : null;

  return {
    userAgent: userAgent.slice(0, 512),
    platform: platform.slice(0, 100),
    hardwareConcurrency,
    visibilityState,
    secureContext: typeof window === 'undefined' ? null : window.isSecureContext,
  };
}

/** Project the versioned runner DTO into a shareable JSON document with no source or transcript. */
export function formatTimeoutDiagnosticsReport(
  report: RunDiagnosticsReport,
  browserContext: TimeoutBrowserContext,
): string {
  return JSON.stringify({
    reportType: 'c-playground-run-timeout',
    reportVersion: REPORT_FORMAT_VERSION,
    run: {
      schemaVersion: report.schemaVersion,
      outcome: report.outcome,
      reason: report.reason,
      document: {
        id: report.document.id,
        sourceRevision: report.document.sourceRevision,
      },
      file: {
        name: report.file.name,
        sizeBytes: report.file.sizeBytes,
        lineCount: report.file.lineCount,
      },
      budgets: {
        uiWatchdogMs: report.budgets.uiWatchdogMs,
        prepare: {
          maxSourceChars: report.budgets.prepare.maxSourceChars,
          maxTokens: report.budgets.prepare.maxTokens,
          maxPreprocessSteps: report.budgets.prepare.maxPreprocessSteps,
          maxDepth: report.budgets.prepare.maxDepth,
        },
        execute: {
          maxInstructions: report.budgets.execute.maxInstructions,
          maxMemoryBytes: report.budgets.execute.maxMemoryBytes,
          maxIOBytes: report.budgets.execute.maxIOBytes,
          maxDepth: report.budgets.execute.maxDepth,
        },
      },
      timingDescription: 'Observed local wall-clock durations in milliseconds. Stages may overlap; these are not CPU time and should not be added together.',
      stages: {
        workerCreateMs: report.stages.workerCreateMs,
        runPostMessageMs: report.stages.runPostMessageMs,
        dispatchToFirstWorkerEventMs: report.stages.dispatchToFirstWorkerEventMs,
        sourceReadMs: report.stages.sourceReadMs,
        prepareMs: report.stages.prepareMs,
        executeActiveMs: report.stages.executeActiveMs,
        stdinWaitMs: report.stages.stdinWaitMs,
        workerTotalMs: report.stages.workerTotalMs,
        watchdogActiveMs: report.stages.watchdogActiveMs,
        mainTotalObservedMs: report.stages.mainTotalObservedMs,
        lastStageObservedMs: report.stages.lastStageObservedMs,
      },
      lastStage: report.lastStage,
      metrics: {
        sourceChars: report.metrics.sourceChars,
        tokenCount: report.metrics.tokenCount,
        preprocessSteps: report.metrics.preprocessSteps,
        instructionCount: report.metrics.instructionCount,
        peakMemoryBytes: report.metrics.peakMemoryBytes,
      },
      diagnostic: {
        code: report.diagnostic.code,
        message: report.diagnostic.message,
      },
    },
    browserContext: {
      userAgent: browserContext.userAgent,
      platform: browserContext.platform,
      hardwareConcurrency: browserContext.hardwareConcurrency,
      visibilityState: browserContext.visibilityState,
      secureContext: browserContext.secureContext,
    },
  }, null, 2);
}
