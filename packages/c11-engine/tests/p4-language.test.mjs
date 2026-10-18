import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import {
  executeTerminated,
  fixtureProject,
  prepareProject,
} from './p4-test-helpers.mjs';

test('a function body may begin with an empty statement', () => {
  const source = 'int main(void) { ; return 0; }';
  executeTerminated(execute, prepareProject(prepare, {
    entry: 'main.c',
    files: [{ name: 'main.c', source }],
  }), undefined, 0);
});

test('multiple translation units link external objects while retaining per-file static linkage', () => {
  const project = fixtureProject('multifile', 'main.c', [
    'main.c', 'value.h', 'value.c', 'private.c',
  ], ['main.c', 'value.c', 'private.c']);
  const program = prepareProject(prepare, project);
  executeTerminated(execute, program);
});

test('external definitions must be unique across translation units', () => {
  const project = fixtureProject('multifile', 'duplicate-main.c', [
    'duplicate-main.c', 'duplicate-a.c', 'duplicate-b.c',
  ], ['duplicate-main.c', 'duplicate-a.c', 'duplicate-b.c']);
  const result = prepare(project);
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.some(({ file }) => ['duplicate-a.c', 'duplicate-b.c'].includes(file)));
});

test('unresolved external references fail during preparation', () => {
  const result = prepare(fixtureProject('multifile', 'unresolved.c'));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].file, 'unresolved.c');
});

test('main receives argc, argv strings and the terminating null pointer', () => {
  const project = fixtureProject('multifile', 'argv.c');
  const program = prepareProject(prepare, project);
  executeTerminated(execute, program, { io: { argv: ['demo', 'north', '42'] } });
});

test('default argv begins with the virtual entry basename', () => {
  const source = 'int main(int argc, char **argv) { return argc == 1 && argv[0][0] == \'a\'; }';
  const project = {
    entry: 'folder/app.c',
    files: [{ name: 'folder/app.c', source }],
  };
  executeTerminated(execute, prepareProject(prepare, project));
});

test('each translation unit gets an independent preprocessor environment', () => {
  const project = fixtureProject('multifile/preprocessor-isolation', 'main.c', [
    'main.c', 'defines.c', 'checks.c',
  ], ['main.c', 'defines.c', 'checks.c']);
  executeTerminated(execute, prepareProject(prepare, project));
});

test('each execute starts from fresh globals and can reuse the same prepared program', () => {
  const project = {
    entry: 'state.c',
    files: [{ name: 'state.c', source: 'int visits; int main(void) { return ++visits; }' }],
  };
  const program = prepareProject(prepare, project);
  executeTerminated(execute, program, undefined, 1);
  executeTerminated(execute, program, undefined, 1);
});

test('K&R function definitions remain callable through a compatible prototype', () => {
  const project = fixtureProject('.', 'legacy-main.c', [
    'legacy-main.c', 'legacy-definition.c',
  ], ['legacy-main.c', 'legacy-definition.c']);
  executeTerminated(execute, prepareProject(prepare, project));
});
