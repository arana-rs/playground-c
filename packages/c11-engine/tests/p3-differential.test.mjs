import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor, writeNativeSource } from './p4-test-helpers.mjs';

// Fixed, finite P3 sources only. Every fixture has defined behavior; the host
// compilers are semantic oracles and never receive editor-provided text.
const samples = [
  ['array decay, indexing and multidimensional parameters', fixtureSourceFor('p3', 'array-decay-native.c'), 1],
  ['object pointer casts, difference and one-past comparison', fixtureSourceFor('p3', 'pointer-casts-difference.c'), 1],
  ['struct value copy, parameter and return', fixtureSourceFor('p3', 'struct-values-native.c'), 1],
  ['union initialization and value copy', fixtureSourceFor('p3', 'union-values-native.c'), 1],
  ['designated initialization, zero fill and brace elision', fixtureSourceFor('p3', 'designators-brace-elision.c'), 1],
  ['direct and builtin function pointer calls', fixtureSourceFor('p3', 'function-pointers-native.c'), 1],
  ['block compound literal lifetime', fixtureSourceFor('p3', 'compound-literal-native.c'), 1],
  ['string terminator and unsigned-character object representation access', fixtureSourceFor('p3', 'strings-object-representation.c'), 1],
  ['static-duration globals and zero initialization', fixtureSourceFor('p3', 'file-scope-storage-native.c'), 1],
  ['malloc, typed access and free', fixtureSourceFor('p3', 'malloc-access-native.c'), 1],
  ['enum values and switch labels', fixtureSourceFor('p3', 'enum-switch-native.c'), 1],
  ['stddef aliases, array size and pointer difference', fixtureSourceFor('p3', 'stddef-pointers-native.c'), 1],
  ['anonymous struct and union members', fixtureSourceFor('p3', 'anonymous-aggregate-native.c'), 1],
  ['file-scope compound literal and global pointer', fixtureSourceFor('p3', 'file-scope-compound-literal-native.c'), 1],
];

for (const compiler of ['gcc', 'clang']) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const skip = process.platform !== 'linux'
    ? 'The oracle uses the Linux LP64 profile and process exit status.'
    : probe.error?.code === 'ENOENT' ? `${compiler} is not installed; portable engine tests still run.` : false;
  test(`P3 agrees with ${compiler} on finite, defined C11 programs`, { skip }, async (t) => {
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    const directory = mkdtempSync(join(tmpdir(), 'c11-p3-oracle-'));
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
          assert.equal(native.status, expected);
          assert.equal(native.signal, null);
          assert.equal(native.stdout, '');
          assert.equal(native.stderr, '');

          const preparation = prepare({ entry: `${index}.c`, files: [{ name: `${index}.c`, source }] });
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
