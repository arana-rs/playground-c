import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, execute, prepare } from '../dist/core/index.js';
import { decodeBytes, fixtureSourceFor } from './p4-test-helpers.mjs';

const fixtures = [
  'math-long-double-families.c',
  'math-fma-rounding.c',
  'math-errors-errno.c',
  'math-api-completion.c',
  'math-api-errno.c',
];

test('capabilities publish the real C11 math API subset and errno profile', () => {
  for (const name of [
    'erf', 'erfc', 'lgamma', 'tgamma', 'nearbyint', 'rint', 'lrint', 'llrint', 'lround', 'llround',
    'remainder', 'remquo', 'frexp', 'modf', 'ilogb', 'logb', 'ldexp', 'scalbn', 'scalbln',
    'nan', 'nextafter', 'nexttoward', 'isgreater', 'isgreaterequal', 'isless', 'islessequal',
    'islessgreater', 'isunordered',
  ]) assert.ok(CAPABILITIES.mathFunctions.includes(name), `${name} should be published`);
  assert.equal(CAPABILITIES.mathErrorHandling, 'MATH_ERRNO-only; domain errors set EDOM; pole and range errors set ERANGE; floating-point exception flags are not exposed');
  assert.ok(CAPABILITIES.mathConstants.includes('HUGE_VALL'));
  assert.deepEqual(CAPABILITIES.mathTypes, ['float_t', 'double_t']);
});

for (const file of fixtures) {
  test(`P6 math interpreter fixture ${file}`, () => {
    const source = fixtureSourceFor('p6', file);
    const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
    assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));

    const result = execute(prepared.program);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 1);
    assert.equal(decodeBytes(result.stdout), '');
    assert.equal(decodeBytes(result.stderr), '');
  });
}

test('ordinary function calls remain invalid in static arithmetic initializers', () => {
  const source = `
static double make_value(void) { return 1.0; }
static double invalid_value = make_value();
int main(void) { return invalid_value == 1.0; }
`;
  const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
  assert.equal(prepared.kind, 'prepare-error', JSON.stringify(prepared));
  assert.ok(prepared.diagnostics.some(({ code }) => code === 'NON_CONSTANT_INITIALIZER'), JSON.stringify(prepared.diagnostics));
});

test('user-defined functions cannot impersonate the math constant-expression helpers', () => {
  const source = `
#include <math.h>
float __c11_inf(void) { return 0.0f; }
static const float invalid_value = INFINITY;
int main(void) { return invalid_value == 0.0f; }
`;
  const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
  assert.equal(prepared.kind, 'prepare-error', JSON.stringify(prepared));
  assert.ok(prepared.diagnostics.some(({ code }) => code === 'NON_CONSTANT_INITIALIZER'), JSON.stringify(prepared.diagnostics));
});
