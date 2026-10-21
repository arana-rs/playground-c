import assert from 'node:assert/strict';
import test from 'node:test';
import { SyntaxAnalysisController } from '../src/editor/syntaxAnalysisController.ts';
import { analyzeSyntaxRequest } from '../src/editor/syntaxAnalysisWorker.ts';
import {
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
} from '../src/execution/documentSnapshot.ts';
import {
  readSyntaxAnalysisMode,
  SYNTAX_ANALYSIS_STORAGE_KEY,
  writeSyntaxAnalysisMode,
} from '../src/editor/syntaxAnalysisPreference.ts';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

class ManualTimers {
  nextId = 0;
  tasks = new Map();

  setTimeout(callback, delayMs) {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(id) { this.tasks.delete(id); }

  runNext() {
    const first = this.tasks.entries().next().value;
    if (!first) return false;
    const [id, task] = first;
    this.tasks.delete(id);
    task.callback();
    return true;
  }

  runAll() {
    while (this.runNext()) {}
  }
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

function createController({ timeoutMs = 10_000, debounceMs = 300 } = {}) {
  const workers = [];
  const timers = new ManualTimers();
  const states = [];
  const controller = new SyntaxAnalysisController({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onStateChange: state => states.push(state),
    timers,
    debounceMs,
    timeoutMs,
  });
  return { controller, workers, timers, states };
}

function workspaceSnapshot(source, { documentId = 'main', fileName = 'main.c', files = [] } = {}) {
  return createWorkspaceSourceSnapshot(
    createExecutionDocumentSnapshot(documentId, fileName, 0, source),
    [{ id: documentId, name: fileName, source }, ...files],
  );
}

function setSource(controller, source) {
  controller.setSnapshot(workspaceSnapshot(source));
}

function resultResponse(jobId, result) {
  return { type: 'result', jobId, result };
}

test('syntax mode defaults to Off, persists valid choices, and tolerates blocked storage', () => {
  const storage = createStorage();
  assert.equal(readSyntaxAnalysisMode(() => storage), 'off');
  assert.equal(writeSyntaxAnalysisMode(() => storage, 'syntax'), true);
  assert.equal(storage.values.get(SYNTAX_ANALYSIS_STORAGE_KEY), 'syntax');
  assert.equal(readSyntaxAnalysisMode(() => storage), 'syntax');

  storage.setItem(SYNTAX_ANALYSIS_STORAGE_KEY, 'invalid');
  assert.equal(readSyntaxAnalysisMode(() => storage), 'off');
  assert.equal(readSyntaxAnalysisMode(() => { throw new Error('storage denied'); }), 'off');
  assert.equal(writeSyntaxAnalysisMode(() => { throw new Error('storage denied'); }, 'off'), false);
});

test('syntax analysis is lazy, debounced, and sends only the latest source with shared preparation options', () => {
  const { controller, workers, timers, states } = createController();
  const prepareOptions = { limits: { maxDepth: 256 } };

  setSource(controller, 'int first;');
  timers.runAll();
  assert.equal(workers.length, 0);

  controller.setEnabled(true);
  assert.equal(controller.currentState.status, 'analyzing');
  setSource(controller, 'int stale;');
  setSource(controller, 'int latest;');
  assert.equal(workers.length, 0);
  timers.runNext();

  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].messages[0], {
    type: 'analyze',
    jobId: 1,
    snapshot: workspaceSnapshot('int latest;'),
    options: {},
  });
  assert.equal(states.at(-1).status, 'analyzing');

  controller.setOptions(prepareOptions);
  assert.equal(workers[0].terminated, true);
  timers.runNext();
  assert.deepEqual(workers[1].messages[0].options, prepareOptions);
  controller.dispose();
});

test('syntax analysis sends the active filename to its Worker', () => {
  const { controller, workers, timers } = createController();
  controller.setSnapshot(workspaceSnapshot('int value;', { documentId: 'unicode', fileName: 'π.c' }));
  controller.setEnabled(true);
  timers.runNext();

  assert.equal(workers[0].messages[0].snapshot.fileName, 'π.c');
  controller.dispose();
});

test('a synchronous edit callback invalidates active analysis before the React effect and rejects stale results', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int old;');
  controller.setEnabled(true);
  timers.runNext();
  const oldWorker = workers[0];
  const staleHandler = oldWorker.onmessage;
  const oldJob = workers[0].messages[0].jobId;
  const staleError = resultResponse(oldJob, {
    kind: 'error',
    diagnostics: [{ code: 'PARSE_ERROR', message: 'expected ;', file: 'main.c', line: 1, column: 5 }],
    truncated: false,
    metrics: {},
  });

  // This is the synchronous callback wired to the editor before React commits its new text.
  setSource(controller, 'int latest;');
  assert.equal(oldWorker.terminated, true);
  assert.deepEqual(controller.currentState, { status: 'analyzing' });
  staleHandler?.({ data: staleError });
  assert.deepEqual(controller.currentState, { status: 'analyzing' });

  timers.runNext();
  const latestWorker = workers[1];
  const latestJob = latestWorker.messages[0].jobId;
  staleHandler?.({ data: resultResponse(oldJob, { kind: 'ok', diagnostics: [], metrics: {} }) });
  assert.deepEqual(controller.currentState, { status: 'analyzing' });
  latestWorker.emit(resultResponse(latestJob, { kind: 'ok', diagnostics: [], metrics: {} }));
  assert.deepEqual(controller.currentState, { status: 'ok' });
  controller.dispose();
});

test('workspace analysis invalidates on sibling content and name changes and ignores stale replies', () => {
  const { controller, workers, timers } = createController();
  const main = { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' };
  const header = { id: 'header', name: 'shared.h', source: 'int value(void);' };
  const helper = { id: 'helper', name: 'helper.c', source: 'int value(void) { return 1; }' };
  const makeSnapshot = (nextHeader = header, nextHelper = helper) => workspaceSnapshot(main.source, {
    files: [nextHeader, nextHelper],
  });

  controller.setSnapshot(makeSnapshot());
  controller.setEnabled(true);
  timers.runNext();
  const firstWorker = workers[0];
  const firstHandler = firstWorker.onmessage;
  const firstJobId = firstWorker.messages[0].jobId;

  controller.setSnapshot(makeSnapshot({ ...header, source: 'int value(void);\n#define VALUE 2' }));
  assert.equal(firstWorker.terminated, true);
  firstHandler?.({ data: resultResponse(firstJobId, { kind: 'ok', diagnostics: [], metrics: {} }) });
  assert.deepEqual(controller.currentState, { status: 'analyzing' });

  timers.runNext();
  const secondWorker = workers[1];
  const secondHandler = secondWorker.onmessage;
  const secondJobId = secondWorker.messages[0].jobId;
  assert.equal(secondWorker.messages[0].snapshot.files[1].source, 'int value(void);\n#define VALUE 2');

  controller.setSnapshot(makeSnapshot({ ...header, source: 'int value(void);\n#define VALUE 2' }, {
    ...helper,
    name: 'renamed-helper.c',
  }));
  assert.equal(secondWorker.terminated, true);
  secondHandler?.({ data: resultResponse(secondJobId, { kind: 'ok', diagnostics: [], metrics: {} }) });
  assert.deepEqual(controller.currentState, { status: 'analyzing' });

  timers.runNext();
  const thirdWorker = workers[2];
  const thirdJobId = thirdWorker.messages[0].jobId;
  assert.equal(thirdWorker.messages[0].snapshot.files[2].name, 'renamed-helper.c');
  thirdWorker.emit(resultResponse(thirdJobId, { kind: 'ok', diagnostics: [], metrics: {} }));
  assert.deepEqual(controller.currentState, { status: 'ok' });
  controller.dispose();
});

test('IME composition cancels active work and analyzes only the final source after composition ends', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int before_composition;');
  controller.setEnabled(true);
  timers.runNext();
  const activeWorker = workers[0];
  const staleHandler = activeWorker.onmessage;
  const staleJobId = activeWorker.messages[0].jobId;

  controller.setComposing(true);
  assert.equal(activeWorker.terminated, true);
  setSource(controller, 'int partial =');
  timers.runAll();
  assert.equal(workers.length, 1);

  setSource(controller, 'int final_value;');
  controller.setComposing(false);
  timers.runNext();
  assert.equal(workers[1].messages[0].snapshot.source, 'int final_value;');
  staleHandler?.({ data: resultResponse(staleJobId, { kind: 'ok', diagnostics: [], metrics: {} }) });
  assert.deepEqual(controller.currentState, { status: 'analyzing' });
  controller.dispose();
});

test('limits and engine failures stay distinct from analysis diagnostic counts', () => {
  const { controller, workers, timers } = createController();
  controller.setEnabled(true);
  setSource(controller, 'int value;');
  timers.runNext();
  const firstJob = workers[0].messages[0].jobId;
  workers[0].emit(resultResponse(firstJob, {
    kind: 'limit',
    stage: 'syntax',
    resource: 'maxTokens',
    limit: 25_000,
    diagnostics: [{ code: 'LIMIT_MAX_TOKENS', message: 'limit', file: 'main.c', line: 1, column: 1 }],
    metrics: {},
  }));
  assert.deepEqual(controller.currentState, { status: 'limit', resource: 'maxTokens' });

  setSource(controller, 'int next_value;');
  timers.runNext();
  const secondJob = workers[0].messages.at(-1).jobId;
  workers[0].emit(resultResponse(secondJob, {
    kind: 'error',
    diagnostics: [{ code: 'ENGINE_INTERNAL_ERROR', message: 'engine failure', file: 'main.c', line: 1, column: 1 }],
    truncated: false,
    metrics: {},
  }));
  assert.deepEqual(controller.currentState, { status: 'unavailable' });
  controller.dispose();
});

test('an error result without diagnostics is unavailable instead of showing a fabricated zero count', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int value;');
  controller.setEnabled(true);
  timers.runNext();
  workers[0].emit(resultResponse(workers[0].messages[0].jobId, {
    kind: 'error',
    diagnostics: [],
    truncated: false,
    metrics: {},
  }));

  assert.deepEqual(controller.currentState, { status: 'unavailable' });
  controller.dispose();
});

test('truncated parser recovery keeps the capped count and announces 20+', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int value;');
  controller.setEnabled(true);
  timers.runNext();
  const jobId = workers[0].messages[0].jobId;
  workers[0].emit(resultResponse(jobId, {
    kind: 'error',
    diagnostics: Array.from({ length: 20 }, (_, index) => ({
      code: 'PARSE_ERROR', message: `error ${index}`, file: 'main.c', line: index + 1, column: 1,
    })),
    truncated: true,
    metrics: {},
  }));
  assert.deepEqual(controller.currentState, {
    status: 'analysis-errors',
    snapshot: workspaceSnapshot('int value;'),
    diagnostics: Array.from({ length: 20 }, (_, index) => ({
      code: 'PARSE_ERROR', message: `error ${index}`, file: 'main.c', line: index + 1, column: 1,
    })),
    diagnosticCount: 20,
    truncated: true,
  });
  controller.dispose();
});

test('current diagnostics are retained for the result and cleared synchronously on edits, composition, and Off', () => {
  const { controller, workers, timers } = createController();
  const diagnostics = [
    { code: 'PARSE_ERROR', message: 'Expected ;.', file: 'main.c', line: 1, column: 8 },
  ];
  setSource(controller, 'int x =');
  controller.setEnabled(true);
  timers.runNext();
  workers[0].emit(resultResponse(workers[0].messages[0].jobId, {
    kind: 'error', diagnostics, truncated: false, metrics: {},
  }));

  assert.deepEqual(controller.currentState, {
    status: 'analysis-errors',
    snapshot: workspaceSnapshot('int x ='),
    diagnostics,
    diagnosticCount: 1,
    truncated: false,
  });

  setSource(controller, 'int x = 1;');
  assert.deepEqual(controller.currentState, { status: 'analyzing' });
  controller.setComposing(true);
  assert.deepEqual(controller.currentState, { status: 'analyzing' });
  controller.setEnabled(false);
  assert.deepEqual(controller.currentState, { status: 'off' });
  controller.dispose();
});

test('Off cancels debounce and terminates active analysis; re-enabling analyzes the latest source', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int latest;');
  controller.setEnabled(true);
  timers.runNext();
  const activeWorker = workers[0];

  controller.setEnabled(false);
  assert.equal(activeWorker.terminated, true);
  assert.deepEqual(controller.currentState, { status: 'off' });
  timers.runAll();
  assert.equal(workers.length, 1);

  setSource(controller, 'int latest_after_off;');
  controller.setEnabled(true);
  timers.runNext();
  assert.equal(workers.length, 2);
  assert.equal(workers[1].messages[0].snapshot.source, 'int latest_after_off;');
  controller.dispose();
});

test('Off clears a not-yet-started debounce without creating a Worker', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int pending;');
  controller.setEnabled(true);
  controller.setEnabled(false);
  timers.runAll();

  assert.equal(workers.length, 0);
  assert.deepEqual(controller.currentState, { status: 'off' });
  controller.dispose();
});

test('Worker failures terminate the active Worker and stale messages cannot replace the failure state', () => {
  const { controller, workers, timers } = createController();
  setSource(controller, 'int value;');
  controller.setEnabled(true);
  timers.runNext();
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;

  worker.onerror?.({ message: 'worker failed' });

  assert.equal(worker.terminated, true);
  assert.deepEqual(controller.currentState, { status: 'unavailable' });
  worker.emit(resultResponse(jobId, { kind: 'ok', diagnostics: [], metrics: {} }));
  assert.deepEqual(controller.currentState, { status: 'unavailable' });
  controller.dispose();
});

test('analysis timeout terminates the Worker and reports a recoverable non-syntax state', () => {
  const { controller, workers, timers } = createController({ timeoutMs: 50 });
  setSource(controller, 'int value;');
  controller.setEnabled(true);
  timers.runNext();
  timers.runNext();

  assert.equal(workers[0].terminated, true);
  assert.deepEqual(controller.currentState, { status: 'timeout' });
  setSource(controller, 'int next_value;');
  timers.runNext();
  assert.equal(workers.length, 2);
  controller.dispose();
});

test('syntax Worker analyzes declarations without a main function and never executes user code', () => {
  const response = analyzeSyntaxRequest({
    type: 'analyze',
    jobId: 91,
    snapshot: workspaceSnapshot('int value;\n'),
    options: {},
  });
  assert.equal(response.type, 'result');
  assert.equal(response.jobId, 91);
  assert.equal(response.result.kind, 'ok');
});

test('syntax analysis keeps the active source filename in diagnostic locations', () => {
  const response = analyzeSyntaxRequest({
    type: 'analyze',
    jobId: 92,
    snapshot: workspaceSnapshot('int value = ;\n', { documentId: 'unicode', fileName: 'π.c' }),
    options: {},
  });
  assert.equal(response.type, 'result');
  assert.equal(response.result.kind, 'error');
  assert.equal(response.result.diagnostics[0].file, 'π.c');
});
