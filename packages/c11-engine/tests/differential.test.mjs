import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor, writeNativeSource } from './p4-test-helpers.mjs';

const project = (body) => ({ entry: 'oracle.c', files: [{ name: 'oracle.c', source: `int main(void) { ${body} }` }] });
const prepared = (body, options) => {
  const result = prepare(project(body), options);
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
};
const sample = (name, body, expected) => ({ name, source: project(body).files[0].source, expected });
const fixtureSample = (name, path, expected) => ({ name, source: fixtureSourceFor('p1', path), expected });

// Fixed, finite programs only: the compilers are test oracles, never a runtime
// for editor input. All executed programs have defined C11 behavior.
const samples = [
  sample('precedence and grouping', 'return 3 + 4 * (8 - 3) - 18 / 3 / 2;', 20),
  sample('octal and hexadecimal', 'return 077 + 0X30 + 0x12;', 129),
  sample('stacked unary operators', 'return - - +19 + -(2 + 3) * -4;', 39),
  fixtureSample('negative dividend', 'negative-dividend.c', -45),
  fixtureSample('negative divisor', 'negative-divisor.c', -35),
  fixtureSample('minimum int without literal overflow', 'minimum-int.c', -1073741824),
  sample('arithmetic at opposite signed boundaries', 'return (-2147483647 - 1) + 2147483647;', -1),
  fixtureSample('initializer resolves declaration visible at that point', 'visible-declaration.c', 13),
  fixtureSample('nested scope updates outer binding', 'nested-scope-update.c', 25),
  fixtureSample('statement assignments and unused expressions', 'statement-assignments.c', 6),
  fixtureSample('main fallthrough', 'main-fallthrough.c', 0),
  fixtureSample('return exits nested scopes before unreachable arithmetic', 'early-return.c', 258),
  sample('negative Linux exit status', 'return -1;', -1),
  sample('Linux exit status reduced modulo 256', 'return 256;', 256),
];

for (const compiler of ['gcc', 'clang']) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const skip = process.platform !== 'linux'
    ? 'The exit-status oracle models Linux process termination.'
    : probe.error?.code === 'ENOENT' ? `${compiler} is not installed; engine tests remain portable.` : false;
  test(`P1 agrees with ${compiler} for defined C11 programs`, { skip }, async (t) => {
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    const directory = mkdtempSync(join(tmpdir(), 'c11-p1-oracle-'));
    try {
      for (const [index, { name, source, expected }] of samples.entries()) {
        await t.test(name, () => {
          const sourcePath = join(directory, `${index}.c`);
          const executablePath = join(directory, `${index}.out`);
          writeNativeSource(sourcePath, source);
          const compilation = spawnSync(compiler, ['-std=c11', '-pedantic-errors', '-O0', ...(compiler === 'clang' ? ['-Werror=newline-eof'] : []), sourcePath, '-o', executablePath], { encoding: 'utf8', timeout: 10000 });
          assert.ifError(compilation.error);
          assert.equal(compilation.status, 0, compilation.stderr);
          const native = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 1000 });
          assert.ifError(native.error);
          assert.equal(native.signal, null);
          assert.equal(native.stdout, '');
          assert.equal(native.stderr, '');

          const preparation = prepare({ entry: 'oracle.c', files: [{ name: 'oracle.c', source }] });
          assert.equal(preparation.kind, 'prepared', JSON.stringify(preparation));
          const interpreted = execute(preparation.program);
          assert.equal(interpreted.kind, 'terminated', JSON.stringify(interpreted));
          // Check the full return too, so modulo 256 cannot hide a wrong value.
          assert.equal(interpreted.mainReturn, expected);
          assert.equal(interpreted.exitCode, native.status);
          assert.equal(native.status, ((expected % 256) + 256) % 256);
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('P1 separates preparation restrictions from detected runtime UB', () => {
  for (const body of [
    'return 7; return missing;',
    'int x = 4; { int y = later; int later = 2; } return x;',
    'int x = 4; { int y = x; } return y;',
  ]) {
    const result = prepare(project(body));
    assert.equal(result.kind, 'prepare-error');
    assert.equal(result.diagnostics[0].code, 'UNKNOWN_IDENTIFIER');
  }
  for (const body of ['int x; return x;', 'int x = x; return x;', 'int x = 7; { int x = x; } return x;']) {
    const result = execute(prepared(body));
    assert.equal(result.kind, 'runtime-error');
    assert.equal(result.diagnostics[0].code, 'UNINITIALIZED_READ');
    assert.equal('exitCode' in result, false);
  }
  for (const body of ['return 2147483647 + 1;', 'return (-2147483647 - 1) % -1;']) {
    const result = execute(prepared(body));
    assert.equal(result.kind, 'runtime-error');
    assert.equal(result.diagnostics[0].code, 'SIGNED_OVERFLOW');
  }
});

test('features beyond P3 remain explicit preparation failures', () => {
  for (const body of [
    'return _Generic(1, int: 2);',
    'return 0b10;',
  ]) {
    const result = prepare(project(body));
    assert.equal(result.kind, 'prepare-error', body);
    assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_FEATURE', body);
  }
});

test('deep valid blocks, unary expressions and grouping run with disabled depth budgets', () => {
  const depth = 2000;
  for (const body of [
    `${'{'.repeat(depth)}return 3;${'}'.repeat(depth)}`,
    `return ${'+ '.repeat(depth)}3;`,
    `return ${'('.repeat(depth)}3${')'.repeat(depth)};`,
  ]) {
    const preparation = prepare(project(body), { limits: { maxDepth: null } });
    assert.equal(preparation.kind, 'prepared', JSON.stringify(preparation));
    const result = execute(preparation.program, { limits: { maxDepth: null } });
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 3);
  }
});

test('resource failures and mutated metrics do not contaminate prepared sessions', () => {
  const preparation = prepare(project('int x = 7; { int y = 3; x *= y; } return x;'));
  assert.equal(preparation.kind, 'prepared');
  const sourceChars = preparation.metrics.sourceChars;
  const tokenCount = preparation.metrics.tokenCount;
  preparation.metrics.sourceChars = -1;
  preparation.metrics.tokenCount = -1;
  assert.equal(execute(preparation.program, { limits: { maxMemoryBytes: 7 } }).kind, 'limit');
  assert.equal(execute(preparation.program, { limits: { maxInstructions: 2 } }).kind, 'limit');
  const first = execute(preparation.program);
  const second = execute(preparation.program);
  for (const result of [first, second]) {
    assert.equal(result.kind, 'terminated');
    assert.equal(result.mainReturn, 21);
    assert.equal(result.metrics.sourceChars, sourceChars);
    assert.equal(result.metrics.tokenCount, tokenCount);
    assert.equal(result.metrics.peakMemoryBytes, 8);
  }
  assert.equal(first.metrics.instructionCount, second.metrics.instructionCount);
  first.metrics.instructionCount = -1;
  assert.ok(second.metrics.instructionCount > 0);
});
