import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { decodeBytes, executeTerminated, fixtureProject, prepareProject } from './p4-test-helpers.mjs';

test('object, function and variadic macros rescan tokens, stringify, paste and honor undef', () => {
  const project = fixtureProject('preprocessor', 'main.c', [
    'main.c', 'include/value.h', 'include/nested/config.h',
  ]);
  executeTerminated(execute, prepareProject(prepare, project));
});

test('stringification preserves UCN spelling while literal UCNs and escapes still translate', () => {
  const program = prepareProject(prepare, {
    entry: 'main.c',
    files: [{
      name: 'main.c',
      source: [
        '#include <stdio.h>',
        '#define STRINGIFY(value) #value',
        'int main(void) {',
        '    puts(STRINGIFY(\\u00E9));',
        '    puts(STRINGIFY("\\u00E9"));',
        '    puts(STRINGIFY("\\\\u00E9"));',
        '    puts(STRINGIFY(alpha   beta));',
        '    puts("\\u00E9");',
        '    return 0;',
        '}',
      ].join('\n'),
    }],
  });

  const result = executeTerminated(execute, program, undefined, 0);
  assert.equal(decodeBytes(result.stdout), '\\u00E9\n"\\u00E9"\n"\\\\u00E9"\nalpha beta\né\n');
});

test('__VA_ARGS__ is limited to variadic macro replacement lists', () => {
  const valid = prepare({
    entry: 'main.c',
    files: [{
      name: 'main.c',
      source: [
        '#if 0',
        '#define SKIPPED(value) __VA_ARGS__',
        '#endif',
        '#define UNUSED(...) __VA_ARGS__',
        '#define STRINGIFY(...) #__VA_ARGS__',
        '#define TEXT(...) "__VA_ARGS__" /* __VA_ARGS__ */',
        '#define STRING "__VA_ARGS__"',
        '#define COMMENT /* __VA_ARGS__ */ 0',
        'int main(void) { return UNUSED(COMMENT); }',
      ].join('\n'),
    }],
  });
  assert.equal(valid.kind, 'prepared', JSON.stringify(valid));
  executeTerminated(execute, valid.program, undefined, 0);

  const invalidSources = [
    '#define OBJECT __VA_ARGS__\nint main(void) { return 0; }',
    '#define FUNCTION(value) __VA_ARGS__\nint main(void) { return 0; }',
    '#define __VA_ARGS__ 0\nint main(void) { return 0; }',
    'int main(void) { return __VA_ARGS__; }',
    '#if __VA_ARGS__\nint value;\n#endif\nint main(void) { return 0; }',
    '#ifdef __VA_ARGS__\nint value;\n#endif\nint main(void) { return 0; }',
    '#undef __VA_ARGS__\nint main(void) { return 0; }',
    '#pragma vendor __VA_ARGS__\nint main(void) { return 0; }',
  ];
  for (const source of invalidSources) {
    const result = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
    assert.equal(result.kind, 'prepare-error', source);
    assert.match(result.diagnostics[0].message, /__VA_ARGS__ may only appear in the replacement list of a variadic function-like macro/);
  }
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

test('#line accepts leading-zero decimal digits and preserves expanded provenance', () => {
  const direct = prepareProject(prepare, {
    entry: 'main.c',
    files: [{
      name: 'main.c',
      source: '#line 0007\nint main(void) { return __LINE__ == 7 ? 0 : 1; }\n',
    }],
  });
  executeTerminated(execute, direct, undefined, 0);

  const expanded = prepare({
    entry: 'main.c',
    files: [{
      name: 'main.c',
      source: '#define TARGET_LINE 0009\n#line TARGET_LINE "synthetic/expanded.c"\n#error expanded line provenance',
    }],
  });
  assert.equal(expanded.kind, 'prepare-error', JSON.stringify(expanded));
  assert.equal(expanded.diagnostics[0].file, 'synthetic/expanded.c');
  assert.equal(expanded.diagnostics[0].line, 9);
  assert.match(expanded.diagnostics[0].message, /expanded line provenance/);
});

test('#line still rejects zero and values above its supported range', () => {
  for (const number of ['0000', '2147483648']) {
    const result = prepare({
      entry: 'main.c',
      files: [{ name: 'main.c', source: `#line ${number}\nint main(void) { return 0; }` }],
    });
    assert.equal(result.kind, 'prepare-error', `#line ${number} should be rejected`);
    assert.match(result.diagnostics[0].message, /#line must be between 1 and 2147483647/);
  }
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

test('unknown non-STDC pragmas are ignored while malformed STDC pragmas keep their diagnostic', () => {
  const program = prepare({
    entry: 'main.c',
    files: [
      {
        name: 'main.c',
        source: [
          '#include "once.h"',
          '#include "once.h"',
          '#pragma vendor unknown_token',
          'int main(void) {',
          '    _Pragma("vendor another_unknown_token");',
          '    return retained();',
          '}',
        ].join('\n'),
      },
      { name: 'once.h', source: '#pragma once\nstatic int retained(void) { return 0; }' },
    ],
  });
  assert.equal(program.kind, 'prepared', JSON.stringify(program));
  executeTerminated(execute, program.program, undefined, 0);

  const invalidStdc = prepare({
    entry: 'main.c',
    files: [{ name: 'main.c', source: '#pragma STDC UNKNOWN ON\nint main(void) { return 0; }' }],
  });
  assert.equal(invalidStdc.kind, 'prepare-error', JSON.stringify(invalidStdc));
  assert.equal(invalidStdc.diagnostics[0].code, 'UNSUPPORTED_FEATURE');
});
