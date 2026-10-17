import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, ENGINE_VERSION, TARGET_PROFILE, execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor } from './p4-test-helpers.mjs';

const project = (source, name = 'p2.c') => ({ entry: name, files: [{ name, source }] });
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
const rejects = (source) => {
  const result = prepare(project(source));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics[0].code);
  assert.equal(result.diagnostics[0].file, 'p2.c');
  assert.ok(result.diagnostics[0].line > 0);
  assert.ok(result.diagnostics[0].column > 0);
  return result.diagnostics[0];
};
const runtimeError = (source, code) => {
  const result = execute(compile(source));
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  if (code) assert.equal(result.diagnostics[0].code, code);
  assert.equal('exitCode' in result, false);
  return result.diagnostics[0];
};

test('P4 preserves P2 scalar/control coverage and publishes current capabilities', () => {
  assert.equal(ENGINE_VERSION, '0.1.0');
  assert.equal(CAPABILITIES.phase, 'P4');
  assert.equal(CAPABILITIES.completeC11, false);
  assert.equal(CAPABILITIES.multipleFiles, true);
  assert.equal(CAPABILITIES.library, 'partial');
  assert.deepEqual(CAPABILITIES.interactiveStdinFunctions, ['scanf', 'fscanf', 'getchar', 'getc', 'fgetc', 'fgets', 'fread']);
  assert.equal(CAPABILITIES.preprocessor, 'c11-translation-phases-and-macros-with-virtual-project-includes');
  assert.deepEqual(CAPABILITIES.virtualHeaders, [
    'assert.h', 'ctype.h', 'errno.h', 'float.h', 'inttypes.h', 'iso646.h',
    'limits.h', 'math.h', 'stdarg.h', 'stdbool.h', 'stddef.h', 'stdint.h',
    'stdio.h', 'stdlib.h', 'string.h', 'wchar.h',
  ]);
  assert.equal(CAPABILITIES.enumerations, 'int-compatible-constants-with-integer-constant-expressions-in-int-range');
  assert.deepEqual(CAPABILITIES.aggregateMembers, ['named', 'anonymous-struct', 'anonymous-union']);
  assert.deepEqual(CAPABILITIES.stddefMacros, ['NULL']);
  assert.deepEqual(CAPABILITIES.stddefTypes, ['size_t', 'ptrdiff_t', 'wchar_t']);
  assert.deepEqual(CAPABILITIES.wideCharacterTypes, ['wchar_t', 'wint_t']);
  assert.deepEqual(CAPABILITIES.floatingTypes, ['float', 'double', 'long double']);
  assert.ok(CAPABILITIES.integerTypes.includes('unsigned long long'));
  assert.equal(CAPABILITIES.mathFunctions.includes('fma'), false);
  assert.equal(TARGET_PROFILE.charSigned, true);
  assert.equal(TARGET_PROFILE.longLongBits, 64);
  assert.equal(TARGET_PROFILE.longDoubleBits, 80);
  assert.equal(TARGET_PROFILE.longDoubleStorageBytes, 16);
  assert.equal(TARGET_PROFILE.longDoubleAlignment, 16);
  assert.equal(TARGET_PROFILE.longDoubleSignificandBits, 64);
  assert.equal(TARGET_PROFILE.longDoubleExponentBits, 15);
  assert.equal(TARGET_PROFILE.floatEvaluationMethod, 0);
  for (const value of [CAPABILITIES, TARGET_PROFILE, CAPABILITIES.virtualHeaders, CAPABILITIES.aggregateMembers, CAPABILITIES.stddefMacros, CAPABILITIES.stddefTypes, CAPABILITIES.wideCharacterTypes, CAPABILITIES.mathFunctions, CAPABILITIES.integerTypes, CAPABILITIES.floatingTypes, CAPABILITIES.interactiveStdinFunctions]) assert.ok(Object.isFrozen(value));
});

test('all LP64 scalar sizes and scalar sizeof expressions use the declared type', () => {
  run(fixtureSourceFor('p2', 'all-lp64-scalar-sizes-and-scalar-sizeof-expressions-use-01.c'), 1);
  run(fixtureSourceFor('p2', 'all-lp64-scalar-sizes-and-scalar-sizeof-expressions-use-02.c'), 1);
});

test('64-bit integer literals and operations preserve values above 2^53 exactly', () => {
  run(fixtureSourceFor('p2', '64-bit-integer-literals-and-operations-preserve-values-01.c'), 1);
  run(fixtureSourceFor('p2', '64-bit-integer-literals-and-operations-preserve-values-02.c'), 1);
  run(fixtureSourceFor('p2', '64-bit-integer-literals-and-operations-preserve-values-03.c'), 1);
  run(fixtureSourceFor('p2', '64-bit-integer-literals-and-operations-preserve-values-04.c'), 1);
  rejects('int main(void) { return sizeof(42UlL); }');
});

test('unsigned wrap and the usual arithmetic conversions follow rank and signedness', () => {
  run(fixtureSourceFor('p2', 'unsigned-wrap-and-the-usual-arithmetic-conversions-follow-01.c'), 1);
  run(fixtureSourceFor('p2', 'unsigned-wrap-and-the-usual-arithmetic-conversions-follow-02.c'), 1);
  run(fixtureSourceFor('p2', 'unsigned-wrap-and-the-usual-arithmetic-conversions-follow-03.c'), 1);
  run(fixtureSourceFor('p2', 'unsigned-wrap-and-the-usual-arithmetic-conversions-follow-04.c'), 1);
});

test('bool normalization and the published signed-narrowing/right-shift profile are explicit', () => {
  run(fixtureSourceFor('p2', 'bool-normalization-and-the-published-signed-narrowing-01.c'), 1);
  // C11 makes these implementation-defined; this suite checks the published
  // two-complement narrowing/arithmetic right-shift profile, not universal C.
  run(fixtureSourceFor('p2', 'bool-normalization-and-the-published-signed-narrowing-02.c'), 1);
  run(fixtureSourceFor('p2', 'bool-normalization-and-the-published-signed-narrowing-03.c'), 1);
});

test('character escapes, suffixes, decimal and hexadecimal floating literals are supported', () => {
  run(fixtureSourceFor('p2', 'character-escapes-suffixes-decimal-and-hexadecimal-01.c'), 1);
  run(fixtureSourceFor('p2', 'character-escapes-suffixes-decimal-and-hexadecimal-02.c'), 1);
});

test('float rounds after operations and conversions while double retains binary64 precision', () => {
  run(fixtureSourceFor('p2', 'float-rounds-after-operations-and-conversions-while-double-01.c'), 1);
  run(fixtureSourceFor('p2', 'float-rounds-after-operations-and-conversions-while-double-02.c'), 1);
  run(fixtureSourceFor('p2', 'float-rounds-after-operations-and-conversions-while-double-03.c'), 1);
  run(fixtureSourceFor('p2', 'float-rounds-after-operations-and-conversions-while-double-04.c'), 1);
  run(fixtureSourceFor('p2', 'float-rounds-after-operations-and-conversions-while-double-05.c'), 1);
});

test('bitwise, shift, comparison and compound operators preserve width and precedence', () => {
  run(fixtureSourceFor('p2', 'bitwise-shift-comparison-and-compound-operators-preserve-01.c'), 1);
  run(fixtureSourceFor('p2', 'bitwise-shift-comparison-and-compound-operators-preserve-02.c'), 13);
  run(fixtureSourceFor('p2', 'bitwise-shift-comparison-and-compound-operators-preserve-03.c'), 1);
  run(fixtureSourceFor('p2', 'bitwise-shift-comparison-and-compound-operators-preserve-04.c'), 1);
});

test('short circuit, ternary and comma sequence only the selected side effects', () => {
  run(fixtureSourceFor('p2', 'short-circuit-ternary-and-comma-sequence-only-the-selected-01.c'), 2);
  run(fixtureSourceFor('p2', 'short-circuit-ternary-and-comma-sequence-only-the-selected-02.c'), 18);
  run(fixtureSourceFor('p2', 'short-circuit-ternary-and-comma-sequence-only-the-selected-03.c'), 1);
  run(fixtureSourceFor('p2', 'short-circuit-ternary-and-comma-sequence-only-the-selected-04.c'), 1);
});

test('assignment expressions and distinct prefix/postfix values work without unsequenced effects', () => {
  run(fixtureSourceFor('p2', 'assignment-expressions-and-distinct-prefix-postfix-values-01.c'), 1);
  run(fixtureSourceFor('p2', 'assignment-expressions-and-distinct-prefix-postfix-values-02.c'), 1);
  run(fixtureSourceFor('p2', 'assignment-expressions-and-distinct-prefix-postfix-values-03.c'), 1);
  run(fixtureSourceFor('p2', 'assignment-expressions-and-distinct-prefix-postfix-values-04.c'), 2);
});

test('detected unsequenced reads/writes stop execution while explicit sequencing remains valid', () => {
  for (const expression of ['i++ + i', '(i = 1) + (i = 2)', 'i = i++', 'i = ++i']) {
    runtimeError(`int main(void) { int i = 0; return ${expression}; }`, 'UNSEQUENCED_ACCESS');
  }
  runtimeError(fixtureSourceFor('p2', 'detected-unsequenced-reads-writes-stop-execution-while-01.c'), 'UNSEQUENCED_ACCESS');
  run(fixtureSourceFor('p2', 'detected-unsequenced-reads-writes-stop-execution-while-02.c'), 3);
});

test('if/else binds dangling else correctly and branch scopes shadow outer locals', () => {
  run(fixtureSourceFor('p2', 'if-else-binds-dangling-else-correctly-and-branch-scopes-01.c'), 3);
  run(fixtureSourceFor('p2', 'if-else-binds-dangling-else-correctly-and-branch-scopes-02.c'), 5);
});

test('switch evaluates its selector once, supports fallthrough/default and nested break', () => {
  run(fixtureSourceFor('p2', 'switch-evaluates-its-selector-once-supports-fallthrough-01.c'), 1);
  run(fixtureSourceFor('p2', 'switch-evaluates-its-selector-once-supports-fallthrough-02.c'), 7);
  run(fixtureSourceFor('p2', 'switch-evaluates-its-selector-once-supports-fallthrough-03.c'), 9);
  run(fixtureSourceFor('p2', 'switch-evaluates-its-selector-once-supports-fallthrough-04.c'), 7);
});

test('while/do and for implement break, continue, declaration scope and loop increments', () => {
  run(fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-01.c'), 8);
  run(fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-02.c'), 4);
  run(fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-03.c'), 1);
  run(fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-04.c'), 4);
  run(fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-05.c'), 23);
});

test('goto labels are function-local and allow forward/backward and outward jumps', () => {
  run(fixtureSourceFor('p2', 'goto-labels-are-function-local-and-allow-forward-backward-01.c'), 3);
  run(fixtureSourceFor('p2', 'goto-labels-are-function-local-and-allow-forward-backward-02.c'), 5);
  const result = run(fixtureSourceFor('p2', 'goto-labels-are-function-local-and-allow-forward-backward-03.c'), 3);
  assert.equal(result.metrics.peakMemoryBytes, 8);
  run(fixtureSourceFor('p2', 'goto-labels-are-function-local-and-allow-forward-backward-04.c'), 3);
  runtimeError(fixtureSourceFor('p2', 'goto-labels-are-function-local-and-allow-forward-backward-05.c'), 'UNINITIALIZED_READ');
});

test('typed prototypes, forward calls and function frames keep argument bindings separate', () => {
  run(fixtureSourceFor('p2', 'typed-prototypes-forward-calls-and-function-frames-keep-01.c'), 42);
  run(fixtureSourceFor('p2', 'typed-prototypes-forward-calls-and-function-frames-keep-02.c'), 17);
  run(fixtureSourceFor('p2', 'typed-prototypes-forward-calls-and-function-frames-keep-03.c'), 1);
});

test('argument and return conversions preserve bool, narrow integers and float types', () => {
  run(fixtureSourceFor('p2', 'argument-and-return-conversions-preserve-bool-narrow-01.c'), 1);
  run(fixtureSourceFor('p2', 'argument-and-return-conversions-preserve-bool-narrow-02.c'), 1);
  run(fixtureSourceFor('p2', 'argument-and-return-conversions-preserve-bool-narrow-03.c'), 8);
});

test('a nonvoid function may fall through only when its absent result is discarded', () => {
  run(fixtureSourceFor('p2', 'a-nonvoid-function-may-fall-through-only-when-its-absent-01.c'), 7);
  for (const expression of ['return f();', 'f() + 1; return 0;', '(int)f(); return 0;']) {
    runtimeError(`int f(void) {} int main(void) { ${expression} }`, 'MISSING_RETURN');
  }
});

test('recursive and mutually recursive functions keep independent locals and return values', () => {
  run(fixtureSourceFor('p2', 'recursive-and-mutually-recursive-functions-keep-01.c'), 1);
  run(fixtureSourceFor('p2', 'recursive-and-mutually-recursive-functions-keep-02.c'), 1);
});

test('explicit runtime frames support recursion deeper than the host stack with limits disabled', () => {
  const program = compile(fixtureSourceFor('p2', 'explicit-runtime-frames-support-recursion-deeper-than-the-01.c'));
  const result = execute(program, { limits: { maxInstructions: null, maxMemoryBytes: null, maxDepth: null } });
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 3000);
  assert.equal(result.metrics.peakMemoryBytes, 4, 'la recursión conserva 3000 frames VM sin reservar parámetros ni locales automáticos');
});

test('known virtual headers expose exact constants, aliases and bool without host I/O', () => {
  run(fixtureSourceFor('p2', 'known-virtual-headers-expose-exact-constants-aliases-and-01.c'), 1);
  run(fixtureSourceFor('p2', 'known-virtual-headers-expose-exact-constants-aliases-and-02.c'), 1);
});

test('math subset provides float/double functions with declared return precision', () => {
  run(fixtureSourceFor('p2', 'math-subset-provides-float-double-functions-with-declared-01.c'), 1);
  run(fixtureSourceFor('p2', 'math-subset-provides-float-double-functions-with-declared-02.c'), 1);
  run(fixtureSourceFor('p2', 'math-subset-provides-float-double-functions-with-declared-03.c'), 1);
  run(fixtureSourceFor('p2', 'math-subset-provides-float-double-functions-with-declared-04.c'), 1);
  run(fixtureSourceFor('p2', 'math-subset-provides-float-double-functions-with-declared-05.c'), 1);
});

test('NaN, infinities, subnormals and signed zero are preserved and classified', () => {
  // IEEE behavior is part of this engine's profile; Annex F conformance is not claimed.
  run(fixtureSourceFor('p2', 'nan-infinities-subnormals-and-signed-zero-are-preserved-01.c'), 1);
});

test('P2 constraints reject invalid operands, lvalues, control placement and function contracts', () => {
  for (const source of [
    'int main(void) { return 1.0 % 2; }', 'int main(void) { return ~1.0; }',
    'int main(void) { return 1 << 1.5; }', 'int main(void) { 1 = 2; return 0; }',
    'int main(void) { ++(1 + 2); return 0; }', 'int main(void) { break; return 0; }',
    'int main(void) { continue; return 0; }', 'int main(void) { goto missing; return 0; }',
    'int main(void) { same: ; same: return 0; }',
    'int main(void) { switch (1) { case 1: ; case 1: return 0; } return 1; }',
    'int main(void) { switch (1.0) { default: return 0; } }',
    'int f(int x); double f(int x) { return x; } int main(void) { return 0; }',
    'int f(int x) { return x; } int main(void) { return f(); }',
    'void f(void) { return 1; } int main(void) { f(); return 0; }',
    'void f(void) { return; } int main(void) { return f(); }',
    '#include <math.h>\nint main(void) { return isnan(1); }',
    '#include <math.h>\nint main(void) { return fpclassify(0); }',
    'int main(void) { for (int i = 0; i < 1; ++i) {} return i; }',
  ]) rejects(source);
});

test('features scheduled after P4 remain explicit preparation rejections', () => {
  for (const source of [
    'int main(void) { return _Generic(1, int: 2); }',
    'int main(void) { _Alignas(16) int value; return value; }',
    '#include <math.h>\nint main(void) { return fma(1.0, 2.0, 3.0); }',
    '#include <threads.h>\nint main(void) { return 0; }',
  ]) rejects(source);
});

test('runtime errors identify the original expression inside a called function', () => {
  const diagnostic = runtimeError(fixtureSourceFor('p2', 'runtime-errors-identify-the-original-expression-inside-a-01.c'), 'DIVISION_BY_ZERO');
  assert.equal(diagnostic.file, 'p2.c');
  assert.equal(diagnostic.line, 2);
  assert.equal(diagnostic.column, 12);
  runtimeError(fixtureSourceFor('p2', 'runtime-errors-identify-the-original-expression-inside-a-02.c'), 'SIGNED_OVERFLOW');
  runtimeError('int main(void) { return 1 << 32; }', 'INVALID_SHIFT');
  runtimeError('int main(void) { return 1 >> -1; }', 'INVALID_SHIFT');
  runtimeError(fixtureSourceFor('p2', 'runtime-errors-identify-the-original-expression-inside-a-03.c'), 'UNINITIALIZED_READ');
  runtimeError('int main(void) { return (int)1e100; }', 'FLOAT_TO_INTEGER_RANGE');
});

test('infinite loops and recursion terminate through instruction/depth budgets, without an exit code', () => {
  for (const source of ['int main(void) { while (1) {} }', 'int main(void) { for (;;) { continue; } }', fixtureSourceFor('p2', 'infinite-loops-and-recursion-terminate-through-instruction-02.c')]) {
    const result = execute(compile(source), { limits: { maxInstructions: 100, maxDepth: null } });
    assert.equal(result.kind, 'limit', JSON.stringify(result));
    assert.equal(result.resource, 'maxInstructions');
    assert.equal('exitCode' in result, false);
    assert.equal(result.diagnostics[0].file, 'p2.c');
  }
  const result = execute(compile(fixtureSourceFor('p2', 'infinite-loops-and-recursion-terminate-through-instruction-01.c')), { limits: { maxDepth: 12 } });
  assert.equal(result.kind, 'limit');
  assert.equal(result.resource, 'maxDepth');
});

test('virtual memory measures live scalar sizes and releases blocks and call frames', () => {
  const source = fixtureSourceFor('p2', 'virtual-memory-measures-live-scalar-sizes-and-releases-03.c');
  const result = run(source, 15);
  assert.equal(result.metrics.peakMemoryBytes, 23);
  const limited = execute(compile(source), { limits: { maxMemoryBytes: 22 } });
  assert.equal(limited.kind, 'limit');
  assert.equal(limited.resource, 'maxMemoryBytes');
  const reuse = run(fixtureSourceFor('p2', 'virtual-memory-measures-live-scalar-sizes-and-releases-01.c'), 0, { limits: { maxMemoryBytes: 12 } });
  assert.equal(reuse.metrics.peakMemoryBytes, 12);
  const calls = run(fixtureSourceFor('p2', 'virtual-memory-measures-live-scalar-sizes-and-releases-02.c'), 4950, { limits: { maxMemoryBytes: 20 } });
  assert.equal(calls.metrics.peakMemoryBytes, 20);
});

test('failed budgets and recursive executions leave a reusable prepared program completely fresh', () => {
  const program = compile(fixtureSourceFor('p2', 'failed-budgets-and-recursive-executions-leave-a-reusable-01.c'));
  assert.equal(execute(program, { limits: { maxMemoryBytes: 10 } }).kind, 'limit');
  assert.equal(execute(program, { limits: { maxInstructions: 10 } }).kind, 'limit');
  assert.equal(execute(program, { limits: { maxDepth: 3 } }).kind, 'limit');
  const first = execute(program);
  assert.equal(first.kind, 'terminated');
  assert.equal(first.mainReturn, 55);
  first.metrics.instructionCount = -1;
  for (let index = 0; index < 3; index++) {
    const next = execute(program);
    assert.equal(next.kind, 'terminated');
    assert.equal(next.mainReturn, 55);
    assert.ok(next.metrics.instructionCount > 0);
    assert.equal(next.metrics.peakMemoryBytes, first.metrics.peakMemoryBytes);
  }
});
