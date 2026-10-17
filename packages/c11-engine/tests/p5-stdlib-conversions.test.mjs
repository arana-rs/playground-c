import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { executeTerminated, fixtureSourceFor, prepareProject } from './p4-test-helpers.mjs';

test('C-locale integer and floating conversions preserve end pointers, LP64 ranges and binary80', () => {
  const program = prepareProject(prepare, { entry: 'stdlib-numeric-conversions.c', files: [{ name: 'stdlib-numeric-conversions.c', source: fixtureSourceFor('p5', 'stdlib-numeric-conversions.c') }] });
  executeTerminated(execute, program, undefined, 0);
});

test('strtold preserves a decimal value that binary64 would round to one', () => {
  const result = prepare({
    entry: 'strtold-precision.c',
    files: [{ name: 'strtold-precision.c', source: `#include <stdlib.h>
int main(void) {
  long double value = strtold("1.0000000000000000001", 0);
  return value > 1.0L ? 0 : 1;
}
` }],
  });
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  executeTerminated(execute, result.program, undefined, 0);
});
