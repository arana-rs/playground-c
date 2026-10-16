import assert from 'node:assert/strict';
import test from 'node:test';

test('worker returns a startup error when project preparation setup throws', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/execution/engine.worker.ts?startup-error-test');
    const file = {
      get name() { throw new Error('falló la lectura del nombre'); },
      async text() { return 'int main(void) { return 0; }'; },
    };
    scope.onmessage({ data: {
      type: 'run',
      jobId: 41,
      file,
      options: { prepare: {}, execute: {} },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(responses.map(response => response.type), ['progress', 'progress', 'error']);
    assert.equal(responses[0].progress.stage, 'source-read');
    assert.equal(responses[1].progress.stage, 'prepare');
    assert.deepEqual(responses.at(-1), {
      type: 'error',
      jobId: 41,
      phase: 'startup',
      message: 'falló la lectura del nombre',
    });
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
    const source = '#include <stdio.h>\nint main(void) {\n  int value = 0;\n  printf("valor? ");\n  if (scanf("%d", &value) != 1) return 1;\n  printf("%d\\n", value);\n  return 0;\n}\n';
    scope.onmessage({ data: {
      type: 'run',
      jobId: 52,
      file: new File([source], 'main.c', { type: 'text/x-c' }),
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
