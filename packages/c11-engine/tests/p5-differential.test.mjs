import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { decodeBytes, fixtureSourceFor, writeNativeSource } from './p4-test-helpers.mjs';

// Under -pedantic-errors, Clang 18 still makes -Wstrict-prototypes fatal here.
// Keep its C23 deprecation warning visible for the intentionally old-style C11 fixtures.
const c11NoPrototypeClangFlags = [
  '-Wno-strict-prototypes',
  '-Wdeprecated-non-prototype',
  '-Wno-error=deprecated-non-prototype',
];

const fixtures = [
  { name: 'generic selection does not evaluate its control or unselected association', files: ['generic-selection.c'], expected: 1 },
  { name: 'generic selection preserves the selected lvalue', files: ['generic-lvalue.c'], expected: 1 },
  { name: 'generic selection remains an integer constant expression in declaration contexts', files: ['generic-ice-constant.c'], expected: 1 },
  { name: 'bitfields share ABI allocation units and preserve zero-width barriers', files: ['bitfields-layout.c'], expected: 1 },
  { name: 'SysV x86-64 bitfield packing and union representation', files: ['bitfields-sysv.c'], expected: 1 },
  { name: 'flexible array allocation and struct assignment omit the tail', files: ['flexible-array-member.c'], expected: 1 },
  { name: 'alignment, offsetof and standard alignment macros', files: ['alignment-stddef.c'], expected: 1 },
  { name: 'object pointer integer roundtrip through uintptr_t', files: ['pointer-uintptr-roundtrip.c'], expected: 1 },
  { name: 'typedef aliases compose with arrays and function pointers', files: ['typedef-declarators.c'], expected: 1 },
  { name: 'qualifiers, prototype arguments and default argument promotions', files: ['qualifiers-promotions.c'], expected: 1 },
  { name: 'array parameter static bounds and adjusted pointer qualifiers', files: ['array-parameter-modifiers.c'], expected: 1 },
  {
    name: 'old-style no-prototype calls and variadic promotions',
    files: ['prototype-default-promotions.c'],
    expected: 1,
    clangFlags: c11NoPrototypeClangFlags,
  },
  { name: 'storage duration, byte representation and effective type', files: ['duration-effective-type.c'], expected: 1 },
  { name: 'thread-local storage in the single-thread profile', files: ['thread-local.c'], expected: 1 },
  {
    name: 'external inline definition resolves from one other translation unit',
    files: ['inline/main.c', 'inline/definition.c', 'inline/inline_api.h'],
    translationUnits: ['inline/main.c', 'inline/definition.c'],
    entry: 'inline/main.c',
    expected: 1,
  },
  {
    name: 'extern inline contributes the unique external definition',
    files: ['inline/extern-inline.c'],
    entry: 'inline/extern-inline.c',
    expected: 1,
  },
  {
    name: 'inline definition permits a static const object with external definition elsewhere',
    files: ['inline/static-const/main.c', 'inline/static-const/inline.c', 'inline/static-const/external.c'],
    translationUnits: ['inline/static-const/main.c', 'inline/static-const/inline.c', 'inline/static-const/external.c'],
    entry: 'inline/static-const/main.c',
    expected: 1,
  },
  {
    name: 'extern inline permits a modifiable block static object',
    files: ['inline/extern-inline-static.c'],
    entry: 'inline/extern-inline-static.c',
    expected: 1,
  },
  {
    name: 'static inline permits a modifiable block static object',
    files: ['inline/static-inline-static.c'],
    entry: 'inline/static-inline-static.c',
    expected: 1,
  },
  {
    name: 'block-scope extern objects and functions resolve across units',
    files: ['block-extern/main.c', 'block-extern/definition.c'],
    translationUnits: ['block-extern/main.c', 'block-extern/definition.c'],
    entry: 'block-extern/main.c',
    expected: 1,
  },
  {
    name: 'incomplete external array receives the complete composite type',
    files: ['linkage-array/main.c', 'linkage-array/definition.c'],
    translationUnits: ['linkage-array/main.c', 'linkage-array/definition.c'],
    entry: 'linkage-array/main.c',
    expected: 1,
  },
  {
    name: 'thread-local storage qualification remains consistent across units',
    files: ['thread-linkage/main.c', 'thread-linkage/definition.c'],
    translationUnits: ['thread-linkage/main.c', 'thread-linkage/definition.c'],
    entry: 'thread-linkage/main.c',
    expected: 1,
  },
  {
    name: 'compatible typedefs and prototype composites use C11 defaults',
    files: ['linkage-composite.c'],
    expected: 1,
    clangFlags: c11NoPrototypeClangFlags,
  },
];

for (const compiler of ['gcc', 'clang']) {
  const probe = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const skip = process.platform !== 'linux'
    ? 'Los oráculos fijan el ABI x86-64 Linux LP64.'
    : probe.error?.code === 'ENOENT' ? `${compiler} no está instalado; las pruebas del intérprete siguen disponibles.`
      : probe.error?.code === 'EPERM' ? 'El sandbox impide crear procesos hijos; los oráculos nativos se ejecutan en CI.' : false;

  test(`P5 coincide con ${compiler} para fixtures C11 definidos y finitos`, { skip }, async (t) => {
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'c11-p5-oracle-'));
    try {
      for (const [index, fixture] of fixtures.entries()) {
        await t.test(fixture.name, () => {
          const files = fixture.files.map((name) => ({
            name,
            source: fixtureSourceFor('p5', name),
          }));
          const entry = fixture.entry ?? files[0].name;
          const project = {
            entry,
            files,
            ...(fixture.translationUnits ? { translationUnits: fixture.translationUnits } : {}),
          };
          const prepared = prepare(project);
          assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
          const interpreted = execute(prepared.program);
          assert.equal(interpreted.kind, 'terminated', JSON.stringify(interpreted));
          assert.equal(interpreted.mainReturn, fixture.expected);
          assert.equal(decodeBytes(interpreted.stdout), '');
          assert.equal(decodeBytes(interpreted.stderr), '');

          const directory = join(temporaryRoot, `${index}-${entry.replaceAll('/', '_')}`);
          mkdirSync(directory, { recursive: true });
          for (const file of files) {
            const path = join(directory, file.name);
            mkdirSync(dirname(path), { recursive: true });
            writeNativeSource(path, file.source);
          }
          const executable = join(directory, 'fixture.out');
          const sourcePaths = files
            .filter(({ name }) => /\.[cC]$/.test(name))
            .map(({ name }) => name);
          const compilation = spawnSync(compiler, [
            '-std=c11', '-pedantic-errors',
            ...(compiler === 'clang'
              ? ['-Werror=newline-eof', '-Werror=strict-prototypes', ...(fixture.clangFlags ?? [])]
              : []),
            ...sourcePaths, '-o', executable,
          ], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
          assert.ifError(compilation.error);
          assert.equal(compilation.status, 0, compilation.stderr);

          const native = spawnSync(executable, [], { cwd: directory, encoding: 'utf8', timeout: 1_000 });
          assert.ifError(native.error);
          assert.equal(native.status, fixture.expected);
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
