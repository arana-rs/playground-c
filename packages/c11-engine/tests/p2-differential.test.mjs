import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor, writeNativeSource } from './p4-test-helpers.mjs';

const main = (body) => `int main(void) { ${body} }`;
// Only fixed, finite sources with defined behavior are executed natively.
// Runtime UB diagnostics, IEEE division by zero, out-of-range casts, negative
// signed right shifts and unsequenced side effects belong to engine-only tests.
const samples = [
  ['exact integer arithmetic beyond JavaScript precision', fixtureSourceFor('p2', 'differential/exact-integer-arithmetic-beyond-javascript-precision.c'), 1],
  ['maximum unsigned and wrapping arithmetic', fixtureSourceFor('p2', 'differential/maximum-unsigned-and-wrapping-arithmetic.c'), 1],
  ['minimum and maximum signed long', fixtureSourceFor('p2', 'differential/minimum-and-maximum-signed-long.c'), -1],
  ['integer literal selection and LP64 sizes', fixtureSourceFor('p2', 'differential/integer-literal-selection-and-lp64-sizes.c'), 1],
  ['integer promotions and mixed-rank comparisons', fixtureSourceFor('p2', 'differential/integer-promotions-and-mixed-rank-comparisons.c'), 1],
  ['conversion to bool and modulo unsigned conversion', fixtureSourceFor('p2', 'differential/conversion-to-bool-and-modulo-unsigned-conversion.c'), 1],
  ['64-bit shifts and bitwise compound assignment', fixtureSourceFor('p2', 'differential/64-bit-shifts-and-bitwise-compound-assignment.c'), 1],
  ['unevaluated sizeof operand', fixtureSourceFor('p2', 'differential/unevaluated-sizeof-operand.c'), 1],
  ['decimal/hex floating and exact conversion', fixtureSourceFor('p2', 'differential/decimal-hex-floating-and-exact-conversion.c'), 1],
  ['character constants with C escapes', main(String.raw`return 'A' + '\n' + '\101' + '\x42';`), 206],
  ['short circuit and ternary branch side effects', fixtureSourceFor('p2', 'differential/short-circuit-and-ternary-branch-side-effects.c'), 18],
  ['comma and assignment expressions', fixtureSourceFor('p2', 'differential/comma-and-assignment-expressions.c'), 23],
  ['prefix and postfix independently sequenced', fixtureSourceFor('p2', 'differential/prefix-and-postfix-independently-sequenced.c'), 24],
  ['dangling else and branch-local scope', fixtureSourceFor('p2', 'differential/dangling-else-and-branch-local-scope.c'), 3],
  ['switch fallthrough and selector effects', fixtureSourceFor('p2', 'differential/switch-fallthrough-and-selector-effects.c'), 9],
  ['while break and continue', fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-01.c'), 8],
  ['do while continues through condition', fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-02.c'), 4],
  ['for declaration shadows outer binding', fixtureSourceFor('p2', 'differential/for-declaration-shadows-outer-binding.c'), 107],
  ['continue in switch targets the enclosing loop', fixtureSourceFor('p2', 'while-do-and-for-implement-break-continue-declaration-05.c'), 23],
  ['forward/backward labels and outward goto', fixtureSourceFor('p2', 'differential/forward-backward-labels-and-outward-goto.c'), 7],
  ['typed prototype and forward definition', fixtureSourceFor('p2', 'differential/typed-prototype-and-forward-definition.c'), 42],
  ['argument/return narrowing and pass by value', fixtureSourceFor('p2', 'differential/argument-return-narrowing-and-pass-by-value.c'), 1],
  ['recursive factorial preserves frames', fixtureSourceFor('p2', 'differential/recursive-factorial-preserves-frames.c'), 1],
  ['mutual recursion and prototype compatibility', fixtureSourceFor('p2', 'recursive-and-mutually-recursive-functions-keep-02.c'), 1],
  ['void function and cast', fixtureSourceFor('p2', 'differential/void-function-and-cast.c'), 8],
  ['nonvoid fallthrough with explicitly discarded result', fixtureSourceFor('p2', 'a-nonvoid-function-may-fall-through-only-when-its-absent-01.c'), 7],
  ['virtual limits, stdint, bool and float constants', fixtureSourceFor('p2', 'differential/virtual-limits-stdint-bool-and-float-constants.c'), 1],
  ['exact math values and typed math prototypes', fixtureSourceFor('p2', 'differential/exact-math-values-and-typed-math-prototypes.c'), 1],
  ['additional exact math values and integer arguments', fixtureSourceFor('p2', 'differential/additional-exact-math-values-and-integer-arguments.c'), 1],
  ['math classification keeps signed zero and float subnormal type', fixtureSourceFor('p2', 'differential/math-classification-keeps-signed-zero-and-float-subnormal.c'), 1],
];

for (const compiler of ['gcc', 'clang']) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const skip = process.platform !== 'linux'
    ? 'This oracle uses the Linux LP64 profile and process exit status.'
    : probe.error?.code === 'ENOENT' ? `${compiler} is not installed; portable engine tests still run.` : false;
  test(`P2 agrees with ${compiler} on finite defined C11 programs`, { skip }, async (t) => {
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    const directory = mkdtempSync(join(tmpdir(), 'c11-p2-oracle-'));
    try {
      for (const [index, [name, source, expected]] of samples.entries()) {
        await t.test(name, () => {
          const sourcePath = join(directory, `${index}.c`);
          const executablePath = join(directory, `${index}.out`);
          writeNativeSource(sourcePath, source);
          const compilation = spawnSync(compiler, ['-std=c11', '-pedantic-errors', '-O0', ...(compiler === 'clang' ? ['-Werror=newline-eof'] : []), sourcePath, '-lm', '-o', executablePath], { encoding: 'utf8', timeout: 10_000 });
          assert.ifError(compilation.error);
          assert.equal(compilation.status, 0, compilation.stderr);
          const native = spawnSync(executablePath, [], { encoding: 'utf8', timeout: 1000 });
          assert.ifError(native.error);
          assert.equal(native.signal, null);
          assert.equal(native.stdout, '');
          assert.equal(native.stderr, '');
          assert.equal(native.status, ((expected % 256) + 256) % 256);

          const preparation = prepare({ entry: 'oracle.c', files: [{ name: 'oracle.c', source }] });
          assert.equal(preparation.kind, 'prepared', JSON.stringify(preparation));
          const interpreted = execute(preparation.program);
          assert.equal(interpreted.kind, 'terminated', JSON.stringify(interpreted));
          assert.equal(interpreted.mainReturn, expected);
          assert.equal(interpreted.exitCode, native.status);
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
