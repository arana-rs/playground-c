import assert from 'node:assert/strict';
import test from 'node:test';
import { formatConsole, RUN_CONFIGURATION, RunnerController } from '../src/execution/useRunner.ts';
import { createRunConfiguration } from '../src/execution/settings.ts';

const bytes = text => new TextEncoder().encode(text);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const metrics = {
  readMs: 0,
  prepareMs: 0,
  executeMs: 0,
  totalMs: 0,
  sourceChars: 0,
  tokenCount: 0,
  preprocessSteps: 0,
  instructionCount: 0,
  peakMemoryBytes: 0,
};

const workerProgress = (stage, overrides = {}) => ({
  stage,
  sourceLineCount: overrides.sourceLineCount ?? 1,
  stages: { workerTotalMs: 1, stdinWaitMs: 0, ...overrides.stages },
  metrics: {
    sourceChars: null,
    tokenCount: null,
    preprocessSteps: null,
    instructionCount: null,
    peakMemoryBytes: null,
    ...overrides.metrics,
  },
});

function terminated(stdout = new Uint8Array()) {
  return {
    kind: 'terminated',
    exitCode: 0,
    rawExitStatus: 0,
    mainReturn: 0,
    stdout,
    stderr: new Uint8Array(),
    metrics,
  };
}

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  messages = [];
  terminated = false;

  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}

function createController(timeoutMs = 10_000) {
  const workers = [];
  const controller = new RunnerController(
    { ...RUN_CONFIGURATION, timeoutMs },
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  );
  const file = new File(['int main(void) { return 0; }'], 'main.c', { type: 'text/x-c' });
  return { controller, workers, file };
}

test('runner streams UTF-8 once, echoes lines once, ignores duplicate events, and supports repeated reads', () => {
  const { controller, workers, file } = createController();
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;

  worker.emit({ type: 'output', jobId, sequence: 1, stream: 'stdout', chunk: Uint8Array.of(0x63, 0x61, 0x66, 0xc3) });
  worker.emit({ type: 'output', jobId, sequence: 2, stream: 'stdout', chunk: Uint8Array.of(0xa9, 0x3a, 0x20) });
  worker.emit({ type: 'output', jobId, sequence: 2, stream: 'stdout', chunk: bytes('duplicate') });
  worker.emit({ type: 'input-needed', jobId, requestId: 1, progress: workerProgress('stdin-wait') });
  worker.emit({ type: 'input-needed', jobId, requestId: 1, progress: workerProgress('stdin-wait') });

  assert.equal(controller.state.status, 'running');
  assert.equal(controller.state.inputRequestId, 1);
  assert.equal(controller.sendStdinLine('7'), true);
  assert.equal(new TextDecoder().decode(worker.messages.at(-1).bytes), '7\n');
  assert.equal(controller.sendStdinLine('duplicate'), false);

  worker.emit({ type: 'output', jobId, sequence: 3, stream: 'stdout', chunk: bytes('Number read: 7\n') });
  worker.emit({ type: 'input-needed', jobId, requestId: 2, progress: workerProgress('stdin-wait') });
  assert.equal(controller.state.inputRequestId, 2);
  assert.equal(controller.sendStdinLine('another line'), true);
  worker.emit({ type: 'result', jobId, result: terminated(bytes('café: 7\nNumber read: 7\n')) });

  assert.equal(controller.state.status, 'finished');
  assert.equal(formatConsole(controller.state), 'café: 7\nNumber read: 7\nanother line\nexit code: 0');
  assert.equal(formatConsole(controller.state).includes('duplicate'), false);
});

test('a run sends its selected budgets to the Worker and keeps them in timeout diagnostics', async () => {
  const { controller, workers, file } = createController();
  const configuration = { ...createRunConfiguration({ maxDepth: 512, maxInstructions: 337_300 }), timeoutMs: 30 };
  controller.run(file, configuration);

  const worker = workers[0];
  const request = worker.messages[0];
  assert.equal(request.options.prepare.limits.maxDepth, 512);
  assert.equal(request.options.execute.limits.maxDepth, 512);
  assert.equal(request.options.execute.limits.maxInstructions, 337_300);

  await pause(45);
  assert.equal(controller.state.status, 'timeout');
  assert.equal(controller.state.diagnosticsReport.budgets.prepare.maxDepth, 512);
  assert.equal(controller.state.diagnosticsReport.budgets.execute.maxDepth, 512);
  assert.equal(controller.state.diagnosticsReport.budgets.execute.maxInstructions, 337_300);
});

test('EOF is explicit, blocks later line sends, and remains visible with partial output', () => {
  const { controller, workers, file } = createController();
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  worker.emit({ type: 'output', jobId, sequence: 1, stream: 'stdout', chunk: bytes('Enter a value: ') });
  worker.emit({ type: 'input-needed', jobId, requestId: 1, progress: workerProgress('stdin-wait') });

  assert.equal(controller.sendStdinEOF(), true);
  assert.deepEqual(worker.messages.at(-1), { type: 'stdin-eof', jobId, requestId: 1 });
  assert.equal(controller.sendStdinLine('ignored'), false);
  assert.match(formatConsole(controller.state), /\[EOF\]/u);
  controller.stop();
  assert.equal(controller.state.status, 'cancelled');
  assert.match(formatConsole(controller.state), /Enter a value: \[EOF\]/u);
  assert.equal(worker.terminated, true);
});

test('stale worker messages cannot change a newer run and Stop preserves its transcript', () => {
  const { controller, workers, file } = createController();
  controller.run(file);
  const first = workers[0];
  const firstId = first.messages[0].jobId;
  first.emit({ type: 'output', jobId: firstId, sequence: 1, stream: 'stdout', chunk: bytes('first') });
  first.emit({ type: 'result', jobId: firstId, result: terminated(bytes('first')) });

  controller.run(file);
  const second = workers[1];
  const secondId = second.messages[0].jobId;
  first.emit({ type: 'output', jobId: firstId, sequence: 2, stream: 'stdout', chunk: bytes('stale') });
  first.emit({ type: 'result', jobId: firstId, result: terminated(bytes('stale')) });
  second.emit({ type: 'output', jobId: secondId, sequence: 1, stream: 'stderr', chunk: bytes('partial') });
  controller.stop();

  assert.equal(controller.state.status, 'cancelled');
  assert.match(formatConsole(controller.state), /stderr:\npartial/u);
  assert.doesNotMatch(formatConsole(controller.state), /stale/u);
});

test('worker startup errors finish the active run immediately with a diagnostic', () => {
  const { controller, workers, file } = createController();
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;

  worker.emit({ type: 'error', phase: 'startup', jobId, message: 'preparation failed' });

  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.reason, 'start');
  assert.match(formatConsole(controller.state), /preparation failed/u);
  assert.equal(worker.terminated, true);
});

test('watchdog pauses for human input and resumes with the remaining active time', async () => {
  const { controller, workers, file } = createController(160);
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  await pause(20);
  worker.emit({ type: 'input-needed', jobId, requestId: 1, progress: workerProgress('stdin-wait') });
  await pause(190);
  assert.equal(controller.state.status, 'running');

  controller.sendStdinLine('1');
  await pause(60);
  assert.equal(controller.state.status, 'running');
  await pause(120);
  assert.equal(controller.state.status, 'timeout');
});

test('timeout preserves a versioned partial report with explicit unknowns and UI watchdog timing', async () => {
  const { controller, workers, file } = createController(45);
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  worker.emit({ type: 'progress', jobId, progress: workerProgress('prepare', {
    sourceLineCount: 3,
    stages: { sourceReadMs: 2.5, workerTotalMs: 8 },
    metrics: { sourceChars: 32, tokenCount: 12, preprocessSteps: 1 },
  }) });

  await pause(70);

  assert.equal(controller.state.status, 'timeout');
  assert.equal(worker.terminated, true);
  const report = controller.state.diagnosticsReport;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.outcome, 'timeout');
  assert.equal(report.reason, 'ui-watchdog');
  assert.equal(report.diagnostic.code, 'RUN_TIMEOUT_UI');
  assert.equal(report.lastStage, 'prepare');
  assert.deepEqual(report.file, { name: 'main.c', sizeBytes: file.size, lineCount: 3 });
  assert.equal(report.budgets.uiWatchdogMs, 45);
  assert.equal(report.budgets.prepare.maxTokens, RUN_CONFIGURATION.options.prepare.limits.maxTokens);
  assert.equal(report.stages.sourceReadMs, 2.5);
  assert.equal(report.stages.prepareMs, null);
  assert.equal(report.stages.executeActiveMs, null);
  assert.equal(report.stages.dispatchToFirstWorkerEventMs >= 0, true);
  assert.equal(report.stages.runPostMessageMs >= 0, true);
  assert.equal(report.stages.watchdogActiveMs >= 45, true);
  assert.equal(report.stages.mainTotalObservedMs >= report.stages.watchdogActiveMs, true);
  assert.equal(report.stages.lastStageObservedMs >= 20, true);
  assert.deepEqual(report.metrics, {
    sourceChars: 32,
    tokenCount: 12,
    preprocessSteps: 1,
    instructionCount: null,
    peakMemoryBytes: null,
  });

  controller.run(file);
  assert.equal(controller.state.status, 'running');
  assert.equal('diagnosticsReport' in controller.state, false);
  controller.stop();
});

test('timeout during execution keeps completed preparation and partial Worker timing', async () => {
  const { controller, workers, file } = createController(45);
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  worker.emit({ type: 'progress', jobId, progress: workerProgress('execute', {
    sourceLineCount: 3,
    stages: { sourceReadMs: 2.5, prepareMs: 4.25, workerTotalMs: 8 },
    metrics: { sourceChars: 32, tokenCount: 12, preprocessSteps: 1 },
  }) });

  await pause(70);

  assert.equal(controller.state.status, 'timeout');
  const report = controller.state.diagnosticsReport;
  assert.equal(report.lastStage, 'execute');
  assert.equal(report.stages.prepareMs, 4.25);
  assert.equal(report.stages.executeActiveMs, null);
  assert.equal(report.stages.workerTotalMs, 8);
  assert.equal(report.stages.lastStageObservedMs >= 20, true);
  assert.equal(report.metrics.sourceChars, 32);
  assert.equal(report.metrics.instructionCount, null);
  assert.equal(report.metrics.peakMemoryBytes, null);
});

test('timeout after resume without preparation counters preserves both phase snapshots', async () => {
  const { controller, workers, file } = createController(45);
  controller.run(file);
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  worker.emit({ type: 'progress', jobId, progress: workerProgress('execute', {
    stages: { sourceReadMs: 2.5, prepareMs: 35.6, workerTotalMs: 42 },
    metrics: { sourceChars: 985, tokenCount: 189, preprocessSteps: 379 },
  }) });
  // Resume snapshots are phase-owned: prep fields may be absent from the
  // session, while execution fields hold the latest cumulative snapshot.
  worker.emit({ type: 'input-needed', jobId, requestId: 1, progress: workerProgress('stdin-wait', {
    stages: { sourceReadMs: 2.5, prepareMs: 35.6, executeActiveMs: 1.4, stdinWaitMs: 0, workerTotalMs: 44 },
    metrics: { sourceChars: null, tokenCount: null, preprocessSteps: null, instructionCount: 57, peakMemoryBytes: 4096 },
  }) });
  assert.equal(controller.sendStdinLine('7'), true);
  worker.emit({ type: 'progress', jobId, progress: workerProgress('execute', {
    stages: { sourceReadMs: 2.5, prepareMs: 35.6, executeActiveMs: 1.4, stdinWaitMs: 0, workerTotalMs: 45 },
    metrics: { sourceChars: null, tokenCount: null, preprocessSteps: null, instructionCount: null, peakMemoryBytes: null },
  }) });

  await pause(70);

  assert.equal(controller.state.status, 'timeout');
  const report = controller.state.diagnosticsReport;
  assert.equal(report.lastStage, 'execute');
  assert.equal(report.metrics.sourceChars, 985);
  assert.equal(report.metrics.tokenCount, 189);
  assert.equal(report.metrics.preprocessSteps, 379);
  assert.equal(report.metrics.instructionCount, 57);
  assert.equal(report.metrics.peakMemoryBytes, 4096);
});

test('timeout before the first worker message identifies startup and keeps transport unknown', async () => {
  const { controller, workers, file } = createController(35);
  controller.run(file);
  const worker = workers[0];

  await pause(60);

  assert.equal(controller.state.status, 'timeout');
  assert.equal(worker.terminated, true);
  const report = controller.state.diagnosticsReport;
  assert.equal(report.lastStage, 'worker-startup');
  assert.equal(report.stages.dispatchToFirstWorkerEventMs, null);
  assert.equal(report.stages.lastStageObservedMs >= 20, true);
  assert.equal(report.stages.sourceReadMs, null);
  assert.equal(report.stages.workerCreateMs >= 0, true);
});
