import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimeoutDiagnosticsReport } from '../src/execution/diagnosticsReport.ts';

const report = {
  schemaVersion: 1,
  outcome: 'timeout',
  reason: 'ui-watchdog',
  document: { id: 'document-main', sourceRevision: 12 },
  file: { name: 'main.c', sizeBytes: 73, lineCount: 4, path: '/private/main.c' },
  budgets: {
    uiWatchdogMs: 10_000,
    prepare: { maxSourceChars: 100, maxTokens: 200, maxPreprocessSteps: 300, maxDepth: 4 },
    execute: { maxInstructions: 400, maxMemoryBytes: 500, maxIOBytes: 600, maxDepth: 7 },
  },
  stages: {
    workerCreateMs: 1,
    runPostMessageMs: 2,
    dispatchToFirstWorkerEventMs: 3,
    sourceReadMs: 4,
    prepareMs: null,
    executeActiveMs: null,
    stdinWaitMs: 0,
    workerTotalMs: null,
    watchdogActiveMs: 10_000,
    mainTotalObservedMs: 10_002,
    lastStageObservedMs: null,
    transcript: 'private console output',
  },
  lastStage: 'prepare',
  metrics: {
    sourceChars: 73,
    tokenCount: null,
    preprocessSteps: null,
    instructionCount: null,
    peakMemoryBytes: null,
  },
  diagnostic: {
    code: 'RUN_TIMEOUT_UI',
    message: 'The interface watchdog stopped the Worker after 10 s of active time; stdin waits are excluded from the budget.',
  },
  source: 'int main(void) { /* private source */ }',
};

test('timeout report keeps the runner DTO fields and omits source, transcript and extra metadata', () => {
  const json = formatTimeoutDiagnosticsReport(report, {
    userAgent: 'Browser UA',
    platform: 'Platform',
    hardwareConcurrency: 8,
    visibilityState: 'visible',
    secureContext: false,
    origin: 'https://user:secret@example.test',
  });
  const parsed = JSON.parse(json);

  assert.equal(parsed.reportVersion, 1);
  assert.equal(parsed.run.schemaVersion, 1);
  assert.equal(parsed.run.outcome, 'timeout');
  assert.equal(parsed.run.reason, 'ui-watchdog');
  assert.deepEqual(parsed.run.document, { id: 'document-main', sourceRevision: 12 });
  assert.equal(parsed.run.file.sizeBytes, 73);
  assert.equal(parsed.run.stages.prepareMs, null);
  assert.equal(parsed.run.stages.mainTotalObservedMs, 10_002);
  assert.equal(parsed.run.lastStage, 'prepare');
  assert.equal(parsed.browserContext.secureContext, false);
  assert.doesNotMatch(json, /private source|private console output|private\/main\.c|user:secret/u);
});
