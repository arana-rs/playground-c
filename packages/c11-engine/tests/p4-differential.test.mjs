import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { decodeBytes, fixtureSource, writeNativeSource } from './p4-test-helpers.mjs';

// These static, finite programs have defined behavior. Host compilers receive
// only repository fixtures, never source written in the editor.
const projects = [
  {
    name: 'macro rescanning and nested virtual includes',
    directory: 'preprocessor',
    entry: 'main.c',
    files: ['main.c', 'include/value.h', 'include/nested/config.h'],
    translationUnits: ['main.c'],
    expected: 1,
  },
  {
    name: 'line splicing, UCN identifiers and adjacent strings',
    directory: 'preprocessor',
    entry: 'splice_ucn_concat.c',
    files: ['splice_ucn_concat.c'],
    expected: 1,
  },
  {
    name: 'line splicing before parsing',
    directory: 'preprocessor',
    entry: 'line_splice.c',
    files: ['line_splice.c'],
    expected: 1,
  },
  {
    name: 'trigraph replacement',
    directory: 'preprocessor',
    entry: 'trigraph.c',
    files: ['trigraph.c'],
    flags: ['-trigraphs'],
    expected: 1,
  },
  {
    name: 'typed prototype with a K&R definition in another unit',
    directory: '.',
    entry: 'legacy-main.c',
    files: ['legacy-main.c', 'legacy-definition.c'],
    translationUnits: ['legacy-main.c', 'legacy-definition.c'],
    expected: 1,
  },
  {
    name: 'variadic promotions and copied argument traversal',
    directory: '.',
    entry: 'varargs.c',
    files: ['varargs.c'],
    expected: 1,
  },
  {
    name: 'multiple translation units with independent static functions',
    directory: 'multifile',
    entry: 'main.c',
    files: ['main.c', 'value.h', 'value.c', 'private.c'],
    translationUnits: ['main.c', 'value.c', 'private.c'],
    expected: 1,
  },
  {
    name: 'argc and argv',
    directory: 'multifile',
    entry: 'argv.c',
    files: ['argv.c'],
    args: ['north', '42'],
    io: { argv: ['demo', 'north', '42'] },
    expected: 1,
  },
  {
    name: 'integer, boolean, alternate operator and numeric macros',
    directory: '.',
    entry: 'headers.c',
    files: ['headers.c'],
    expected: 1,
  },
  {
    name: 'stdio formatting',
    directory: '.',
    entry: 'stdio-format.c',
    files: ['stdio-format.c'],
    expected: 1,
  },
  {
    name: 'stdio output bytes',
    directory: '.',
    entry: 'stdio-output.c',
    files: ['stdio-output.c'],
    stdout: 'value=42\n',
    stderr: 'done:ok',
    expected: 0,
  },
  {
    name: 'binary virtual file input and output',
    directory: '.',
    entry: 'stdio-files.c',
    files: ['stdio-files.c'],
    io: { files: [{ name: 'input.bin', data: new Uint8Array([65, 0, 66]) }] },
    hostFiles: [{ name: 'input.bin', data: new Uint8Array([65, 0, 66]) }],
    expected: 1,
  },
  {
    name: 'stdin and end of file',
    directory: '.',
    entry: 'stdio-input.c',
    files: ['stdio-input.c'],
    io: { stdin: 'hello\nX' },
    stdin: 'hello\nX',
    expected: 1,
  },
  {
    name: 'active assertion',
    directory: '.',
    entry: 'assert-enabled.c',
    files: ['assert-enabled.c'],
    expected: 0,
  },
  {
    name: 'NDEBUG disables assertions',
    directory: '.',
    entry: 'assert-disabled.c',
    files: ['assert-disabled.c'],
    expected: 42,
  },
  {
    name: 'C locale ctype and errno conversion',
    directory: '.',
    entry: 'ctype-errno.c',
    files: ['ctype-errno.c'],
    expected: 1,
  },
  {
    name: 'inttypes formatting, scanning and conversion',
    directory: '.',
    entry: 'inttypes.c',
    files: ['inttypes.c'],
    expected: 1,
  },
  {
    name: 'FLT_TRUE_MIN and DBL_TRUE_MIN remain subnormal without volatile',
    directory: '.',
    entry: 'float-classification.c',
    files: ['float-classification.c'],
    expected: 0,
  },
  {
    name: 'byte and string operations',
    directory: '.',
    entry: 'strings.c',
    files: ['strings.c'],
    expected: 1,
  },
];

for (const compiler of ['gcc', 'clang']) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5000 });
  const skip = process.platform !== 'linux'
    ? 'The fixture checks the x86-64 Linux LP64 profile.'
    : probe.error?.code === 'ENOENT' ? `${compiler} is not installed; engine tests still run.` : false;

  test(`P4 agrees with ${compiler} on fixed, finite C11 fixtures`, { skip }, async (t) => {
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'c11-p4-oracle-'));
    try {
      for (const [index, sample] of projects.entries()) {
        await t.test(sample.name, () => {
          const projectFiles = sample.files.map((name) => ({
            name,
            source: fixtureSource(sample.directory, name),
          }));
          const project = {
            entry: sample.entry,
            files: projectFiles,
            ...(sample.translationUnits ? { translationUnits: sample.translationUnits } : {}),
          };
          const prepared = prepare(project);
          assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
          const interpreted = execute(prepared.program, sample.io ? { io: sample.io } : undefined);
          assert.equal(interpreted.kind, 'terminated', JSON.stringify(interpreted));
          assert.equal(interpreted.mainReturn, sample.expected);
          assert.equal(decodeBytes(interpreted.stdout), sample.stdout ?? '');
          assert.equal(decodeBytes(interpreted.stderr), sample.stderr ?? '');

          const directory = join(temporaryRoot, `${index}-${sample.entry.replaceAll('/', '_')}`);
          mkdirSync(directory, { recursive: true });
          for (const file of projectFiles) {
            const path = join(directory, file.name);
            mkdirSync(dirname(path), { recursive: true });
            writeNativeSource(path, file.source);
          }
          for (const file of sample.hostFiles ?? []) writeFileSync(join(directory, file.name), file.data);

          const executable = join(directory, 'fixture.out');
          const sourcePaths = projectFiles
            .filter(({ name }) => /\.[cC]$/.test(name))
            .map(({ name }) => name);
          const compilation = spawnSync(compiler, [
            '-std=c11', '-pedantic-errors', ...(sample.flags ?? []), ...(compiler === 'clang' ? ['-Werror=newline-eof'] : []), ...sourcePaths,
            '-o', executable,
          ], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
          assert.ifError(compilation.error);
          assert.equal(compilation.status, 0, compilation.stderr);

          const native = spawnSync(executable, sample.args ?? [], {
            cwd: directory,
            encoding: 'utf8',
            input: sample.stdin,
            timeout: 1000,
          });
          assert.ifError(native.error);
          assert.equal(native.status, sample.expected);
          assert.equal(native.signal, null);
          assert.equal(native.stdout, sample.stdout ?? '');
          assert.equal(native.stderr, sample.stderr ?? '');
        });
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}
