import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createDebugSession, execute, prepare } from '../dist/core/index.js';
import { decodeBytes, fixtureSourceFor, writeNativeSource } from './p4-test-helpers.mjs';

const fixtures = [
  { name: 'dynamic sizeof captures bounds, nested dimensions, typedefs and parameter adjustment', file: 'vla-runtime-sizeof.c' },
  { name: 'sizeof of a VLA pointed to by a pointer preserves its runtime stride and operand effects', file: 'vla-pointer-sizeof.c' },
  { name: 'the Memory Viewer sees the concrete extent of an active VLA', file: 'vla-debug-inspection.c' },
  { name: 'the published long double math variants preserve their result types and family semantics', file: 'math-long-double-families.c', linkMath: true },
  { name: 'fma, fmaf and fmal round the exact ternary result once', file: 'math-fma-rounding.c', linkMath: true },
  { name: 'the C11 real math API, constants, return types and comparison macros match native compilers', file: 'math-api-completion.c', linkMath: true },
];

for (const compiler of ['gcc', 'clang']) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const skip = process.platform !== 'linux'
    ? 'The oracles target the x86-64 Linux LP64 ABI.'
    : probe.error?.code === 'ENOENT' ? `${compiler} is not installed; interpreter tests remain available.`
      : probe.error?.code === 'EPERM' ? 'The sandbox prevents child processes; native oracles run in CI.' : false;

  test(`P6 matches ${compiler} for defined, finite C11 fixtures`, { skip }, async (t) => {
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'c11-p6-oracle-'));
    try {
      for (const [index, fixture] of fixtures.entries()) {
        await t.test(fixture.name, () => {
          const source = fixtureSourceFor('p6', fixture.file);
          const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
          assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));

          const interpreted = execute(prepared.program);
          assert.equal(interpreted.kind, 'terminated', JSON.stringify(interpreted));
          assert.equal(interpreted.mainReturn, 1);
          assert.equal(decodeBytes(interpreted.stdout), '');
          assert.equal(decodeBytes(interpreted.stderr), '');

          const directory = join(temporaryRoot, String(index));
          mkdirSync(directory, { recursive: true });
          writeNativeSource(join(directory, 'main.c'), source);
          const executable = join(directory, 'fixture.out');
          const compilation = spawnSync(compiler, [
            '-std=c11', '-pedantic-errors',
            ...(compiler === 'clang' ? ['-Werror=newline-eof', '-Werror=strict-prototypes'] : []),
            'main.c', ...(fixture.linkMath ? ['-lm'] : []), '-o', executable,
          ], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
          assert.ifError(compilation.error);
          assert.equal(compilation.status, 0, compilation.stderr);

          const native = spawnSync(executable, [], { cwd: directory, encoding: 'utf8', timeout: 1_000 });
          assert.ifError(native.error);
          assert.equal(native.status, 1);
          assert.equal(native.signal, null);
          assert.equal(native.stdout, '');
          assert.equal(native.stderr, '');
        });
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}

test('debug array inspection publishes a VLA’s resolved extent after its declaration executes', () => {
  const source = fixtureSourceFor('p6', 'vla-debug-inspection.c');
  const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const session = createDebugSession(prepared.program);
  let progress;
  for (let step = 0; step < 20; step += 1) {
    progress = session.resume();
    if (progress.kind !== 'paused' || progress.location.line >= 5) break;
  }
  assert.equal(progress?.kind, 'paused', JSON.stringify(progress));
  assert.equal(progress.location.line, 5);
  const array = session.inspectArrays().arrays.find(({ name }) => name === 'values');
  assert.ok(array, 'the active VLA should appear in array inspection');
  assert.equal(array.length, 4);
  assert.equal(array.size, 4 * 4);
  assert.equal(array.elements.length, 4);
  assert.match(array.type, /4/, 'the published type should include the resolved bound');
});
