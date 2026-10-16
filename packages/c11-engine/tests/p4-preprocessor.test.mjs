import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { executeTerminated, fixtureProject, prepareProject } from './p4-test-helpers.mjs';

test('object, function and variadic macros rescan tokens, stringify, paste and honor undef', () => {
  const project = fixtureProject('preprocessor', 'main.c', [
    'main.c', 'include/value.h', 'include/nested/config.h',
  ]);
  executeTerminated(execute, prepareProject(prepare, project));
});

test('trigraphs, line splicing, universal character names and adjacent strings translate before parsing', () => {
  const trigraphs = prepareProject(prepare, fixtureProject('preprocessor', 'trigraph.c'));
  executeTerminated(execute, trigraphs);

  const spliced = prepareProject(prepare, fixtureProject('preprocessor', 'line_splice.c'));
  executeTerminated(execute, spliced);

  const translated = prepareProject(prepare, fixtureProject('preprocessor', 'splice_ucn_concat.c'));
  executeTerminated(execute, translated);
});

test('line controls update predefined file and line macros', () => {
  const program = prepareProject(prepare, fixtureProject('preprocessor', 'builtin-macros.c'));
  executeTerminated(execute, program);
});

test('#error diagnostics retain #line file and line provenance', () => {
  const result = prepare(fixtureProject('preprocessor', 'provenance.c'));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].file, 'virtual/provenance.c');
  assert.equal(result.diagnostics[0].line, 401);
  assert.match(result.diagnostics[0].message, /expected synthetic provenance/);
});

test('included #error diagnostics retain the included header line-control provenance', () => {
  const result = prepare({
    entry: 'main.c',
    files: [
      { name: 'main.c', source: '#include "include/failure.h"\nint main(void) { return 0; }' },
      { name: 'include/failure.h', source: '#line 321 "synthetic/header.c"\n#error included provenance' },
    ],
  });
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].file, 'synthetic/header.c');
  assert.equal(result.diagnostics[0].line, 321);
  assert.match(result.diagnostics[0].message, /included provenance/);
});

test('preprocessing steps use their own exact preparation budget and metric', () => {
  const project = fixtureProject('preprocessor', 'main.c', [
    'main.c', 'include/value.h', 'include/nested/config.h',
  ]);
  const complete = prepare(project);
  assert.equal(complete.kind, 'prepared', JSON.stringify(complete));
  assert.ok(complete.metrics.preprocessSteps > 0);

  const exact = prepare(project, {
    limits: { maxTokens: null, maxPreprocessSteps: complete.metrics.preprocessSteps },
  });
  assert.equal(exact.kind, 'prepared', JSON.stringify(exact));
  assert.equal(exact.metrics.preprocessSteps, complete.metrics.preprocessSteps);

  const limited = prepare(project, {
    limits: { maxTokens: null, maxPreprocessSteps: complete.metrics.preprocessSteps - 1 },
  });
  assert.equal(limited.kind, 'limit', JSON.stringify(limited));
  assert.equal(limited.stage, 'prepare');
  assert.equal(limited.resource, 'maxPreprocessSteps');
  assert.ok(limited.metrics.preprocessSteps > complete.metrics.preprocessSteps - 1);
});

test('missing quoted includes fail in the virtual project without host lookup', () => {
  const project = {
    entry: 'missing.c',
    files: [{ name: 'missing.c', source: '#include "not-in-project.h"\nint main(void) { return 0; }' }],
  };
  const result = prepare(project);
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].file, 'missing.c');
});

test('STDC pragmas and the _Pragma operator accept supported modes', () => {
  const program = prepareProject(prepare, fixtureProject('preprocessor', 'pragma.c'));
  executeTerminated(execute, program);
});
