import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const project = (source) => ({ entry: 'main.c', files: [{ name: 'main.c', source }] });
const compile = (source) => {
  const result = prepare(project(source));
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
};
const rejects = (source) => {
  const result = prepare(project(source));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.code));
  return result.diagnostics[0];
};

test('VLA bounds are captured per declaration and per recursive activation', () => {
  const source = `
    #ifdef __STDC_NO_VLA__
    #error VLA support must not be reported as unavailable
    #endif
    #include <stddef.h>
    static int recurse(int length) {
      int values[length];
      values[0] = length;
      if (length == 1) return sizeof values == sizeof(int);
      return values[0] == length && recurse(length - 1) && sizeof values == (size_t)length * sizeof(int);
    }
    int main(void) {
      int length = 3;
      int values[length];
      length = 7;
      if (sizeof values != 3 * sizeof(int)) return 0;
      for (int bound = 1; bound <= 4; ++bound) {
        int iteration[bound];
        if (sizeof iteration != (size_t)bound * sizeof(int)) return 0;
      }
      return recurse(4);
    }
  `;
  const result = execute(compile(source));
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);
});

test('static pointers to VLA types are valid while VLA objects cannot have static duration', () => {
  const source = `
    int matrix[2][3];
    int main(void) {
      int columns = 3;
      static int (*row)[columns] = matrix;
      return row == matrix && sizeof *row == 3 * sizeof(int);
    }
  `;
  const result = execute(compile(source));
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);
  assert.match(rejects('int main(void) { int n = 2; static int values[n]; return 0; }').message, /static or thread storage/);
});

test('array parameter adjustment retains prototype-scope star bounds', () => {
  const source = `
    int row_size(int columns, int values[*][columns]);
    int main(void) { return 1; }
  `;
  assert.equal(prepare(project(source)).kind, 'prepared');
  const diagnostic = rejects('int row_size(int columns, int values[*]) { return sizeof values; } int main(void) { return 0; }');
  assert.match(diagnostic.message, /function prototype scope/);
  assert.match(rejects('int main(void) { int values[*]; return 0; }').message, /function prototype scope/);
});

test('incomplete arrays remain distinct from VLAs', () => {
  const source = `
    typedef int Unspecified[];
    int main(void) {
      Unspecified values = { 1, 2, 3 };
      return sizeof values == 3 * sizeof(int);
    }
  `;
  const result = execute(compile(source));
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);
  assert.match(rejects('int main(void) { int values[]; return 0; }').message, /complete type/);
});

test('rejects invalid VM scope, linkage, element type, and initialization constraints', () => {
  const cases = [
    'int n = 2; int values[n]; int main(void) { return 0; }',
    'int main(void) { int n = 2; extern int (*row)[n]; return 0; }',
    'int main(void) { double n = 2.0; int values[n]; return 0; }',
    'int main(void) { int n = 2; int values[n] = { 1, 2 }; return 0; }',
  ];
  for (const source of cases) {
    const result = prepare(project(source));
    assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
    assert.ok(result.diagnostics[0].code);
  }
});

test('runtime VLA bounds must be positive and VLA allocation obeys the memory budget', () => {
  const zeroBound = execute(compile('int main(void) { int length = 0; int values[length]; return 0; }'));
  assert.equal(zeroBound.kind, 'runtime-error', JSON.stringify(zeroBound));
  assert.equal(zeroBound.diagnostics[0].code, 'INVALID_ARRAY_BOUND');

  const limited = execute(compile('int main(void) { int length = 100; int values[length]; return 0; }'), {
    limits: { maxMemoryBytes: 16 },
  });
  assert.equal(limited.kind, 'limit', JSON.stringify(limited));
  assert.equal(limited.resource, 'maxMemoryBytes');
});
