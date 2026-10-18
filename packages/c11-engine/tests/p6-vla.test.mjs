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

test('goto rejects entering a VLA, variably modified pointer, typedef, or for scope', () => {
  const cases = [
    'int main(void) { int length = 2; goto target; int values[length]; target: return 0; }',
    'int main(void) { int length = 2; goto target; int (*row)[length]; target: return 0; }',
    'int main(void) { int length = 2; goto target; typedef int Row[length]; target: return 0; }',
    'int main(void) { int length = 2; goto target; for (int (*row)[length] = 0; 0; ) { target: return 0; } return 1; }',
  ];
  for (const source of cases) {
    const diagnostic = rejects(source);
    assert.equal(diagnostic.code, 'TYPE_ERROR');
    assert.match(diagnostic.message, /goto statement cannot jump into the scope/);
  }
});

test('goto remains valid within or out of VM scope and can enter a fixed-array scope', () => {
  const cases = [
    {
      source: 'int main(void) { int length = 2; int values[length]; goto target; return 1; target: return sizeof values == 2 * sizeof(int) ? 0 : 2; }',
      expected: 0,
    },
    {
      source: 'int main(void) { goto done; { int length = 2; int values[length]; return 1; } done: return 0; }',
      expected: 0,
    },
    {
      source: 'int main(void) { goto target; { int values[2]; target: values[0] = 7; return values[0] == 7 ? 0 : 1; } }',
      expected: 0,
    },
  ];
  for (const { source, expected } of cases) {
    const result = execute(compile(source));
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, expected);
  }
});

test('backward goto restarts VLA lifetimes while retaining typedef bounds and VM pointer objects', () => {
  const sources = [
    `int main(void) {
      int length = 1, iterations = 0;
    again:
      if (iterations == 2) return 0;
      int values[length];
      if (sizeof values / sizeof values[0] != (unsigned long)length) return 1;
      length++;
      iterations++;
      goto again;
    }`,
    `int main(void) {
      int length = 0, iterations = 0;
      typedef int Row[++length];
    again:
      ;
      Row values;
      if (sizeof values / sizeof values[0] != 1) return 1;
      if (iterations == 2) return length == 1 ? 0 : 2;
      iterations++;
      goto again;
    }`,
    `int one[1];
    int two[2];
    int main(void) {
      int length = 1, iterations = 0;
    again:
      ;
      if (iterations == 2) return 0;
      int (*row)[length];
      if (iterations == 0) row = &one;
      else {
        if ((void *)row != (void *)&one) return 1;
        row = &two;
      }
      if (sizeof *row / sizeof(int) != (unsigned long)length) return 2;
      length++;
      iterations++;
      goto again;
    }`,
  ];
  for (const source of sources) {
    const result = execute(compile(source));
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 0);
  }
});

test('switch rejects case and default labels inside VM scope but allows existing and fixed scopes', () => {
  const invalid = [
    'int main(void) { switch (0) { int length = 2; int values[length]; case 0: return 0; } return 1; }',
    'int main(void) { switch (0) { int length = 2; typedef int Row[length]; case 0: return 0; } return 1; }',
    'int main(void) { switch (0) { int length = 2; int (*row)[length] = 0; default: return 0; } return 1; }',
  ];
  for (const source of invalid) {
    const diagnostic = rejects(source);
    assert.equal(diagnostic.code, 'TYPE_ERROR');
    assert.match(diagnostic.message, /switch statement cannot jump to a case or default label/);
  }

  const valid = [
    'int main(void) { int length = 2; int values[length]; switch (0) { case 0: return sizeof values == 2 * sizeof(int) ? 0 : 1; } return 1; }',
    'int main(void) { switch (0) { int values[2]; case 0: return 0; } return 1; }',
    'int main(void) { switch (0) { case 0: return 0; int length = 2; int values[length]; } return 1; }',
  ];
  for (const source of valid) {
    const result = execute(compile(source));
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 0);
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
