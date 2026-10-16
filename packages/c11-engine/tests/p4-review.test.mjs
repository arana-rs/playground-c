import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { executeTerminated, fixtureProject, prepareProject } from './p4-test-helpers.mjs';

const entry = {
  entry: 'review.c',
  files: [{ name: 'review.c', source: 'int main(void) { return 0; }' }],
};

test('an incomplete tentative external array completes to one element at translation-unit end', () => {
  const project = {
    entry: 'tentative-array.c',
    files: [{
      name: 'tentative-array.c',
      source: 'int a[]; int main(void) { return a[0]; }',
    }],
  };
  executeTerminated(execute, prepareProject(prepare, project), undefined, 0);
});

test('an empty parameter list on a function definition means no parameters', () => {
  const project = {
    entry: 'old-main.c',
    files: [{ name: 'old-main.c', source: 'int main() { return 0; }' }],
  };
  executeTerminated(execute, prepareProject(prepare, project), undefined, 0);
});

test('_Noreturn declarations and definitions are accepted when the function does not return', () => {
  const project = fixtureProject('.', 'noreturn.c');
  executeTerminated(execute, prepareProject(prepare, project), undefined, 0);
});

test('tentative external definitions merge within one TU and link through extern in another TU', () => {
  const project = {
    entry: 'tentative/main.c',
    translationUnits: ['tentative/main.c', 'tentative/definitions.c'],
    files: [
      {
        name: 'tentative/main.c',
        source: 'extern int value; int main(void) { return value == 0 ? 0 : 1; }',
      },
      {
        name: 'tentative/definitions.c',
        source: 'int value; int value;',
      },
    ],
  };
  executeTerminated(execute, prepareProject(prepare, project), undefined, 0);
});

test('tentative definitions in distinct TUs diagnose duplicate external definitions', () => {
  const project = {
    entry: 'tentative-duplicate/main.c',
    translationUnits: [
      'tentative-duplicate/main.c',
      'tentative-duplicate/a.c',
      'tentative-duplicate/b.c',
    ],
    files: [
      {
        name: 'tentative-duplicate/main.c',
        source: 'extern int value; int main(void) { return value; }',
      },
      { name: 'tentative-duplicate/a.c', source: 'int value;' },
      { name: 'tentative-duplicate/b.c', source: 'int value;' },
    ],
  };
  const result = prepare(project);
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics.some(({ file }) => file.endsWith('/a.c') || file.endsWith('/b.c')));
});

test('an initialized definition conflicts with a tentative definition in another TU', () => {
  const project = {
    entry: 'tentative-initialized/main.c',
    translationUnits: [
      'tentative-initialized/main.c',
      'tentative-initialized/a.c',
      'tentative-initialized/b.c',
    ],
    files: [
      {
        name: 'tentative-initialized/main.c',
        source: 'extern int value; int main(void) { return value; }',
      },
      { name: 'tentative-initialized/a.c', source: 'int value = 42;' },
      { name: 'tentative-initialized/b.c', source: 'int value;' },
    ],
  };
  const result = prepare(project);
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics.some(({ file }) => file.endsWith('/a.c') || file.endsWith('/b.c')));
});

test('a runtime-invalid stdin type produces a specific I/O diagnostic', () => {
  const program = prepareProject(prepare, entry);
  const result = execute(program, { io: { stdin: 123 } });
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'INVALID_IO_OPTIONS');
  assert.notEqual(result.diagnostics[0].code, 'ENGINE_INTERNAL_ERROR');
  assert.deepEqual(result.stdout, new Uint8Array());
  assert.deepEqual(result.stderr, new Uint8Array());
});

class TrackedBytes extends Uint8Array {
  copies = 0;
  slice(...indices) {
    this.copies += 1;
    return super.slice(...indices);
  }
}

test('stdin and seeded files are rejected by maxIOBytes before copying input buffers', () => {
  const program = prepareProject(prepare, entry);
  const inputs = [
    ['stdin', (data) => ({ stdin: data })],
    ['seed file', (data) => ({ files: [{ name: 'data.bin', data }] })],
  ];

  for (const [name, makeIO] of inputs) {
    const bytes = new TrackedBytes([1, 2, 3, 4]);
    const result = execute(program, { io: makeIO(bytes), limits: { maxIOBytes: 3 } });
    assert.equal(result.kind, 'limit', name + ': ' + JSON.stringify(result));
    assert.equal(result.stage, 'execute');
    assert.equal(result.resource, 'maxIOBytes');
    assert.equal(result.metrics.instructionCount, 0);
    assert.equal(bytes.copies, 0);
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.deepEqual(result.stdout, new Uint8Array());
    assert.deepEqual(result.stderr, new Uint8Array());
  }
});
