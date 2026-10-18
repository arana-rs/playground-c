import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor } from './p4-test-helpers.mjs';

const project = (source) => ({ entry: 'p3.c', files: [{ name: 'p3.c', source }] });

const compile = (source, options) => {
  const result = prepare(project(source), options);
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
};

const run = (source, expected, options) => {
  const result = execute(compile(source), options);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected, source);
  return result;
};

const runtimeError = (source) => {
  const result = execute(compile(source));
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0].file, 'p3.c');
  assert.equal('exitCode' in result, false);
  return result;
};

const preparationError = (source) => {
  const result = prepare(project(source));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0].file, 'p3.c');
  return result;
};

test('local arrays retain size while parameters decay, including multidimensional rows and strings', () => {
  run(fixtureSourceFor('p3', 'arrays-sizeof.c'), 1);
});

test('object pointers support null, void-pointer round trips, aliasing and bounded arithmetic', () => {
  run(fixtureSourceFor('p3', 'object-pointers.c'), 1);
});

test('unsigned character pointers can inspect and update an integer representation', () => {
  run(fixtureSourceFor('p3', 'byte-representation.c'), 1);
});

test('unsigned character views expose aggregate and initialized heap object bytes', () => {
  run(fixtureSourceFor('p3', 'aggregate-heap-representation.c'), 1);
});

test('struct values copy, pass and return by value, with dot and arrow access', () => {
  run(fixtureSourceFor('p3', 'struct-values.c'), 1);
});

test('function pointers preserve typed calls through a parameter and a local alias', () => {
  run(fixtureSourceFor('p3', 'function-pointers.c'), 1);
});

test('relational pointers follow member order within structs and compare union members equally', () => {
  run(fixtureSourceFor('p3', 'relational-member-pointers.c'), 1);
  runtimeError('int main(void) { struct S { int first[1]; int second[1]; } value; return &value.first[0] < &value.second[0]; }');
  runtimeError('int main(void) { int first[1]; int second[1]; return &first[0] < &second[0]; }');
  runtimeError('int main(void) { int first = 1; int second = 2; return &first < &second; }');
});

test('union values can be initialized, copied and accessed through either member operator', () => {
  run(fixtureSourceFor('p3', 'unions-by-value.c'), 1);
  run(fixtureSourceFor('p3', 'union-byte-representation.c'), 1);
  run(fixtureSourceFor('p3', 'union-float-representation.c'), 1);
});

test('aggregate designators select fields and indices while omitted members are zero-filled', () => {
  run(fixtureSourceFor('p3', 'aggregate-designators.c'), 1);
});

test('brace-elided array initialization and enum constants follow C11 aggregate order', () => {
  run(fixtureSourceFor('p3', 'brace-elision-enum.c'), 1);
});

test('anonymous struct and union members expose fields in initialization and access', () => {
  run(fixtureSourceFor('p3', 'anonymous-aggregate-members.c'), 1);
});

test('stddef.h exposes the P3 size, pointer-difference and null aliases', () => {
  run(fixtureSourceFor('p3', 'stddef-aliases.c'), 1);
});

test('block-scope compound literals remain addressable for their full block lifetime', () => {
  run(fixtureSourceFor('p3', 'block-compound-literal-lifetime.c'), 1);
  runtimeError(`int main(void) {
    struct Pair { int left; int right; };
    struct Pair *expired;
    { expired = &(struct Pair) { 3, 4 }; }
    return expired->left;
  }`);
});

test('file-scope compound literals have static duration and reset with globals', () => {
  const program = compile(fixtureSourceFor('p3', 'file-scope-compound-literal.c'));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = execute(program);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 1);
    assert.equal(result.metrics.peakMemoryBytes, 16);
  }
});

test('file-scope initializers reject runtime expressions that are not C constant expressions', () => {
  preparationError('int index = 1; int values[2]; int *selected = &values[index]; int main(void) { return selected == &values[1] ? 0 : 1; }');
  preparationError('int object; int invalid = !&object; int main(void) { return invalid; }');
});

test('array members of returned aggregate temporaries expire at the end of the full expression', () => {
  run(fixtureSourceFor('p3', 'aggregate-temporary.c'), 1);
  runtimeError(fixtureSourceFor('p3', 'aggregate-temporary-expired.c'));

  const peakProgram = compile(fixtureSourceFor('p3', 'aggregate-temporary-repeated-peak.c'));
  const peak = execute(peakProgram);
  assert.equal(peak.kind, 'terminated', JSON.stringify(peak));
  assert.equal(peak.mainReturn, 1);
  assert.equal(peak.metrics.peakMemoryBytes, 12);
});

test('selection and iteration substatements end their implicit compound-literal scope', () => {
  run(fixtureSourceFor('p3', 'substatement-compound-literal-live.c'), 1);

  runtimeError(fixtureSourceFor('p3', 'substatement-compound-literal-expired-if.c'));

  runtimeError(fixtureSourceFor('p3', 'substatement-compound-literal-expired-for.c'));

  runtimeError(fixtureSourceFor('p3', 'substatement-compound-literal-expired-while.c'));
});

test('one-past pointers may be formed but out-of-object and expired-object reads fail', () => {
  run('int main(void) { int values[2] = { 6, 9 }; int *end = values + 2; return end - values == 2; }', 1);
  runtimeError('int main(void) { int values[2] = { 6, 9 }; return values[2]; }');
  runtimeError('int main(void) { int values[2] = { 6, 9 }; int *past = values + 3; return past == 0; }');
  runtimeError('int main(void) { int first[1]; int second[1]; return &first[0] - &second[0]; }');
  runtimeError('int main(void) { int matrix[2][2] = { 1, 2, 3, 4 }; return matrix[0][2]; }');
  runtimeError('int main(void) { int values[2] = { 6, 9 }; int *end = values + 2; return *end; }');
  runtimeError('int main(void) { int *expired; { int value = 7; expired = &value; } return *expired; }');
});

test('null dereference and use after free stop execution with runtime diagnostics', () => {
  runtimeError('int main(void) { int *value = 0; return *value; }');
  runtimeError('int identity(int value) { return value; } int main(void) { int (*function)(int) = 0; return function(7); }');
  runtimeError(fixtureSourceFor('p3', 'heap-use-after-free.c'));
  runtimeError(fixtureSourceFor('p3', 'heap-uninitialized-read.c'));
  runtimeError(fixtureSourceFor('p3', 'heap-invalid-free.c'));
  runtimeError(fixtureSourceFor('p3', 'heap-double-free.c'));
});

test('string literals include NUL, consume static storage and reject writes', () => {
  const program = compile('int main(void) { char *text = "abc"; return text[3] == \'\\0\'; }');
  const result = execute(program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);
  assert.equal(result.metrics.peakMemoryBytes, 12);

  runtimeError('int main(void) { char *text = "abc"; text[0] = \'x\'; return 0; }');
});

test('malloc/free manage heap storage, accept free(NULL), and allow zero-size frees', () => {
  run(fixtureSourceFor('p3', 'malloc-free.c'), 1);
});

test('long double preserves binary80 across storage, aggregates, memcpy, calls and variadic arguments', () => {
  run(fixtureSourceFor('p3', 'long-double-storage.c'), 0);
});

test('realloc supports null, growth, shrink, zero-size release, failure preservation, and pointer provenance copies', () => {
  const program = compile(fixtureSourceFor('p3', 'realloc.c'));
  assert.equal(program.hasHeapAllocationCalls, true);
  run(fixtureSourceFor('p3', 'realloc.c'), 1);
});

test('realloc applies the memory budget to the resized live heap without double-counting the old block', () => {
  const program = compile(`#include <stdlib.h>
int main(void) {
  int *values = malloc(sizeof(int));
  if (values == NULL) return 0;
  values[0] = 5;
  values = realloc(values, 2 * sizeof(int));
  if (values == NULL) return 0;
  values[1] = 2;
  return values[0] == 5 ? 1 : 0;
}`);

  const exactBudget = execute(program, { limits: { maxMemoryBytes: 16 } });
  assert.equal(exactBudget.kind, 'terminated', JSON.stringify(exactBudget));
  assert.equal(exactBudget.mainReturn, 1);
  assert.equal(exactBudget.metrics.peakMemoryBytes, 16);

  const tooSmall = execute(program, { limits: { maxMemoryBytes: 15 } });
  assert.equal(tooSmall.kind, 'limit', JSON.stringify(tooSmall));
  assert.equal(tooSmall.resource, 'maxMemoryBytes');
  assert.equal(tooSmall.metrics.peakMemoryBytes, 12);
});

test('realloc diagnoses invalid bases, stale aliases, bounds changes, and indeterminate growth bytes', () => {
  const invalidInterior = runtimeError('#include <stdlib.h>\nint main(void) { int *values = malloc(8); return realloc(values + 1, 16) != 0; }');
  assert.equal(invalidInterior.diagnostics[0].code, 'INVALID_REALLOC');

  const freed = runtimeError('#include <stdlib.h>\nint main(void) { int *values = malloc(4); free(values); return realloc(values, 8) != 0; }');
  assert.equal(freed.diagnostics[0].code, 'INVALID_REALLOC');

  const staleAlias = runtimeError('#include <stdlib.h>\nint main(void) { int *values = malloc(4); int *alias = values; values = realloc(values, 8); return alias[0]; }');
  assert.equal(staleAlias.diagnostics[0].code, 'INACTIVE_OBJECT');

  const shrunkBounds = runtimeError('#include <stdlib.h>\nint main(void) { int *values = malloc(8); values = realloc(values, 4); return values[1]; }');
  assert.equal(shrunkBounds.diagnostics[0].code, 'POINTER_BOUNDS');

  const uninitializedGrowth = runtimeError('#include <stdlib.h>\nint main(void) { int *values = malloc(4); values = realloc(values, 8); return values[1]; }');
  assert.equal(uninitializedGrowth.diagnostics[0].code, 'UNINITIALIZED_READ');
});

test('realloc keeps LP64 size_t values as BigInt until the profile range check', () => {
  const result = execute(compile('#include <stdlib.h>\nint main(void) { int *value = malloc(4); return realloc(value, 9007199254740993UL) != 0; }'));
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'TYPE_SIZE_RANGE');
});

test('live automatic and heap storage obey the shared byte budget and execution state resets', () => {
  const program = compile(fixtureSourceFor('p3', 'live-storage-budget.c'));

  const constrained = execute(program, { limits: { maxMemoryBytes: 15 } });
  assert.equal(constrained.kind, 'limit', JSON.stringify(constrained));
  assert.equal(constrained.resource, 'maxMemoryBytes');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = execute(program, { limits: { maxMemoryBytes: 16 } });
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 1);
    assert.equal(result.metrics.peakMemoryBytes, 16);
  }

  const failedSession = compile(fixtureSourceFor('p3', 'execution-state-after-failure.c'));
  assert.equal(execute(failedSession).kind, 'runtime-error');
  const freshSession = execute(compile('int main(void) { return 42; }'), { limits: { maxMemoryBytes: 0 } });
  assert.equal(freshSession.kind, 'terminated', JSON.stringify(freshSession));
  assert.equal(freshSession.mainReturn, 42);
});

test('file-scope objects have static duration, zero initialization and fresh values per execution', () => {
  const program = compile(fixtureSourceFor('p3', 'file-scope-storage-reset.c'));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = execute(program);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 1);
    assert.equal(result.metrics.peakMemoryBytes, 16);
  }
});

test('static string-literal storage is included in live-byte budgets', () => {
  const program = compile('int main(void) { char *text = "abc"; return text[3] == \'\\0\'; }');
  const constrained = execute(program, { limits: { maxMemoryBytes: 11 } });
  assert.equal(constrained.kind, 'limit', JSON.stringify(constrained));
  assert.equal(constrained.resource, 'maxMemoryBytes');

  const result = execute(program, { limits: { maxMemoryBytes: 12 } });
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);
  assert.equal(result.metrics.peakMemoryBytes, 12);
});

test('void pointers cannot be indexed or advanced without conversion to an object pointer type', () => {
  preparationError('int main(void) { void *value = 0; return value[0]; }');
  preparationError('int main(void) { void *value = 0; return value + 1 != 0; }');
});
