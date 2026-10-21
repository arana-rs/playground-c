import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
} from '../src/execution/documentSnapshot.ts';

function workspaceSnapshot(source, files = []) {
  return createWorkspaceSourceSnapshot(
    createExecutionDocumentSnapshot('main', 'main.c', 0, source),
    [{ id: 'main', name: 'main.c', source }, ...files],
  );
}

test('worker reports a read error when the captured snapshot source cannot be read', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/execution/engine.worker.ts?startup-error-test');
    const snapshot = new Proxy(workspaceSnapshot('int main(void) { return 0; }'), {
      get(target, key, receiver) {
        if (key === 'source') throw new Error('failed to read the captured source');
        return Reflect.get(target, key, receiver);
      },
    });
    scope.onmessage({ data: {
      type: 'run',
      jobId: 41,
      snapshot,
      options: { prepare: {}, execute: {} },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(responses.map(response => response.type), ['progress', 'result']);
    assert.equal(responses[0].progress.stage, 'source-read');
    assert.equal(responses.at(-1).jobId, 41);
    assert.equal(responses.at(-1).result.kind, 'read-error');
    assert.equal(responses.at(-1).result.diagnostics[0].file, 'main.c');
    assert.match(responses.at(-1).result.diagnostics[0].message, /failed to read the captured source/u);
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('worker reports transition timings and counter snapshots around interactive stdin', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/execution/engine.worker.ts?stdin-progress-test');
    const source = '#include <stdio.h>\nint main(void) {\n  int value = 0;\n  printf("value? ");\n  if (scanf("%d", &value) != 1) return 1;\n  printf("%d\\n", value);\n  return 0;\n}\n';
    scope.onmessage({ data: {
      type: 'run',
      jobId: 52,
      snapshot: workspaceSnapshot(source),
      options: { prepare: {}, execute: {} },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));

    const input = responses.find(response => response.type === 'input-needed');
    assert.ok(input);
    assert.deepEqual(responses.filter(response => response.type === 'progress').map(response => response.progress.stage), [
      'source-read', 'prepare', 'execute',
    ]);
    assert.equal(input.progress.stage, 'stdin-wait');
    assert.equal(typeof input.progress.stages.sourceReadMs, 'number');
    assert.equal(typeof input.progress.stages.prepareMs, 'number');
    assert.equal(typeof input.progress.stages.executeActiveMs, 'number');
    assert.equal(typeof input.progress.stages.workerTotalMs, 'number');
    assert.equal(input.progress.sourceLineCount, 8);
    assert.equal(typeof input.progress.metrics.tokenCount, 'number');
    assert.equal(input.progress.metrics.sourceChars > 0, true);
    assert.equal(input.progress.metrics.preprocessSteps > 0, true);
    assert.equal(typeof input.progress.metrics.instructionCount, 'number');

    scope.onmessage({ data: {
      type: 'stdin', jobId: 52, requestId: input.requestId, bytes: new TextEncoder().encode('7\n'),
    } });
    const result = responses.find(response => response.type === 'result');
    assert.equal(result.result.kind, 'terminated');
    assert.equal(result.result.metrics.instructionCount > 0, true);
    assert.equal(responses.filter(response => response.type === 'progress').at(-1).progress.stage, 'execute');
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the execution Worker enforces the instruction budget supplied by Run', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/execution/engine.worker.ts?execution-settings-budget-test');
    const source = 'int main(void) { int value = 0; while (value < 100) { value = value + 1; } return value; }';
    scope.onmessage({ data: {
      type: 'run',
      jobId: 53,
      snapshot: workspaceSnapshot(source),
      options: {
        prepare: { limits: { maxDepth: 512 } },
        execute: { limits: { maxDepth: 512, maxInstructions: 1 } },
      },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));

    const result = responses.find(response => response.type === 'result');
    assert.ok(result, 'the Worker returns a result for the configured Run request');
    assert.equal(result.result.kind, 'limit');
    assert.equal(result.result.resource, 'maxInstructions');
    assert.equal(result.result.limit, 1);
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});
