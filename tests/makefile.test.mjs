import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMakefile } from '../src/build/makefile.ts';

function diagnosticFor(result, pattern) {
  return result.diagnostics.find(item => pattern.test(item.message));
}

test('parses the supported compiler recipe and preserves ordered translation units', () => {
  const result = parseMakefile(
    [
      'CC := cc',
      'SOURCES := main.c util.c',
      'app: $(SOURCES) util.h',
      '\t$(CC) $(SOURCES) -o $@',
    ].join('\n'),
    ['main.c', 'util.c', 'util.h'],
  );

  assert.deepEqual(result.plan, {
    target: 'app',
    entry: 'main.c',
    translationUnits: ['main.c', 'util.c'],
  });
  assert.deepEqual(result.diagnostics, []);
});

test('implements recursive = and immediate := expansion, including forward references', () => {
  const result = parseMakefile(
    [
      'FROZEN := $(LATER)',
      'LATER = main.c',
      'SOURCES = $(LATER) util.c',
      'all: app',
      'app: $(SOURCES) util.h',
      '\tclang $(FROZEN) $(SOURCES) -o $@',
    ].join('\n'),
    ['main.c', 'util.c', 'util.h'],
  );

  assert.deepEqual(result.plan, {
    target: 'app',
    entry: 'main.c',
    translationUnits: ['main.c', 'util.c'],
  });
  assert.deepEqual(result.diagnostics, []);
});

test('uses the first normal rule as the default and resolves a single aggregation alias', () => {
  const result = parseMakefile(
    [
      '# A phony declaration does not become the default goal.',
      '.PHONY: all',
      'all: app',
      'app: main.c util.h',
      '\tcc main.c -o $@',
    ].join('\n'),
    ['main.c', 'util.h'],
  );

  assert.equal(result.plan?.target, 'app');
  assert.deepEqual(result.plan?.translationUnits, ['main.c']);
  assert.deepEqual(result.diagnostics, []);
});

test('uses GNU-style empty expansion for undefined names and the default CC value', () => {
  const result = parseMakefile('app: main.c\n\t$(CC) $(UNSET) main.c -o $@\n', ['main.c']);

  assert.deepEqual(result.plan, {
    target: 'app',
    entry: 'main.c',
    translationUnits: ['main.c'],
  });
  assert.deepEqual(result.diagnostics, []);
});

test('reports missing prerequisites at their original Makefile column', () => {
  const result = parseMakefile('app: missing.h\n\tcc main.c -o $@\n', ['main.c']);
  const diagnostic = diagnosticFor(result, /Prerequisite 'missing\.h'/);

  assert.equal(result.plan, null);
  assert.deepEqual(diagnostic, {
    file: 'Makefile',
    line: 1,
    column: 6,
    message: "Prerequisite 'missing.h' is not available and has no target rule.",
  });
});

test('reports unsupported compiler flags at the original recipe location', () => {
  const result = parseMakefile('app: main.c\n\tcc -Wall main.c -o app\n', ['main.c']);
  const diagnostic = diagnosticFor(result, /Compiler flag '-Wall'/);

  assert.equal(result.plan, null);
  assert.equal(diagnostic?.line, 2);
  assert.equal(diagnostic?.column, 5);
});

test('rejects headers as compiler operands instead of filtering them', () => {
  const result = parseMakefile('app: main.c util.h\n\tcc main.c util.h -o app\n', ['main.c', 'util.h']);
  const diagnostic = diagnosticFor(result, /Header files are prerequisites/);

  assert.equal(result.plan, null);
  assert.equal(diagnostic?.line, 2);
  assert.equal(diagnostic?.column, 12);
});

test('rejects $^ explicitly and points to the original automatic-variable reference', () => {
  const result = parseMakefile('app: main.c\n\tcc $^ -o app\n', ['main.c']);
  const diagnostic = diagnosticFor(result, /automatic variable \$\^ is unsupported/);

  assert.equal(result.plan, null);
  assert.equal(diagnostic?.line, 2);
  assert.equal(diagnostic?.column, 5);
});

test('detects recursive variable cycles without hanging', () => {
  const result = parseMakefile(
    'A = $(B)\nB = $(A)\napp: main.c\n\tcc $(A) main.c -o $@\n',
    ['main.c'],
  );
  const diagnostic = diagnosticFor(result, /Variable expansion cycle detected: A -> B -> A/);

  assert.equal(result.plan, null);
  assert.equal(diagnostic?.line, 2);
  assert.equal(diagnostic?.column, 5);
});

test('detects dependency cycles at the edge that closes the cycle', () => {
  const result = parseMakefile(
    'all: app\napp: all main.c\n\tcc main.c -o app\n',
    ['main.c'],
  );
  const diagnostic = diagnosticFor(result, /Dependency cycle detected: all -> app -> all/);

  assert.equal(result.plan, null);
  assert.equal(diagnostic?.line, 2);
  assert.equal(diagnostic?.column, 6);
});

test('bounds dependency traversal depth', () => {
  const rules = [];
  for (let index = 0; index < 130; index++) {
    rules.push(index === 129 ? `t${index}: main.c` : `t${index}: t${index + 1}`);
  }
  rules.push('\tcc main.c -o t129');
  const result = parseMakefile(rules.join('\n'), ['main.c']);

  assert.equal(result.plan, null);
  assert.ok(diagnosticFor(result, /Dependency depth exceeds the 128-rule limit/));
});

test('rejects an aggregation goal that reaches multiple programs', () => {
  const result = parseMakefile(
    [
      'all: app demo',
      'app: main.c',
      '\tcc main.c -o app',
      'demo: demo.c',
      '\tgcc demo.c -o demo',
    ].join('\n'),
    ['main.c', 'demo.c'],
  );

  assert.equal(result.plan, null);
  assert.ok(diagnosticFor(result, /reaches multiple programs/));
});

test('reports unsupported syntax and recipe constructs instead of ignoring them', async t => {
  const cases = [
    {
      name: 'included makefiles',
      source: 'include common.mk\n',
      files: [],
      pattern: /Included Makefiles are unsupported/,
    },
    {
      name: 'pattern rules',
      source: '%.o: %.c\n',
      files: [],
      pattern: /Pattern rules and wildcards are unsupported/,
    },
    {
      name: 'shell redirection',
      source: 'app: main.c\n\tcc main.c -o app > app.log\n',
      files: ['main.c'],
      pattern: /Shell operators and redirections are unsupported/,
    },
    {
      name: 'shell quoting',
      source: 'app: main.c\n\tcc "main.c" -o app\n',
      files: ['main.c'],
      pattern: /Quoting is unsupported/,
    },
    {
      name: 'unsupported make function',
      source: 'app: main.c\n\tcc $(wildcard *.c) -o app\n',
      files: ['main.c'],
      pattern: /Make functions.*unsupported/,
    },
    {
      name: 'inline recipe',
      source: 'app: main.c ; cc main.c -o app\n',
      files: ['main.c'],
      pattern: /Inline recipes are unsupported/,
    },
    {
      name: 'multiple recipe lines',
      source: 'app: main.c\n\tcc main.c -o app\n\tcc main.c -o app\n',
      files: ['main.c'],
      pattern: /Multiple recipe lines/,
    },
    {
      name: 'append assignment',
      source: 'SOURCES += main.c\napp: main.c\n\tcc main.c -o app\n',
      files: ['main.c'],
      pattern: /assignment operator is unsupported/,
    },
    {
      name: 'object target',
      source: 'app.o: main.c\n\tcc main.c -o app.o\n',
      files: ['main.c'],
      pattern: /Object-file targets/,
    },
    {
      name: 'output mismatch',
      source: 'app: main.c\n\tcc main.c -o different\n',
      files: ['main.c'],
      pattern: /must match rule target/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = parseMakefile(item.source, item.files);
      assert.equal(result.plan, null);
      assert.ok(diagnosticFor(result, item.pattern), result.diagnostics.map(value => value.message).join('\n'));
    });
  }
});

test('rejects duplicate variable definitions and target rules', () => {
  const duplicateVariable = parseMakefile(
    'SOURCES = main.c\nSOURCES = other.c\napp: main.c\n\tcc main.c -o app\n',
    ['main.c', 'other.c'],
  );
  const duplicateRule = parseMakefile(
    'app: main.c\napp: main.c\n\tcc main.c -o app\n',
    ['main.c'],
  );

  assert.ok(diagnosticFor(duplicateVariable, /defined more than once/));
  assert.ok(diagnosticFor(duplicateRule, /duplicate rules are unsupported/));
});

test('rejects a missing compiler recipe or missing source file', () => {
  const missingRecipe = parseMakefile('app: main.c\n', ['main.c']);
  const missingSource = parseMakefile('app: missing.c\n\tcc missing.c -o app\n', []);

  assert.equal(missingRecipe.plan, null);
  assert.ok(diagnosticFor(missingRecipe, /does not resolve to a compiler recipe/));
  assert.equal(missingSource.plan, null);
  assert.ok(diagnosticFor(missingSource, /is not available in the current workspace/));
});

test('enforces parser and expansion bounds with useful diagnostics', () => {
  const tooLarge = parseMakefile('x'.repeat(65_537), []);
  const hugeExpansion = parseMakefile(
    `SOURCES = ${'a'.repeat(32_769)}\napp:\n\tcc $(SOURCES) -o app\n`,
    [],
  );

  assert.equal(tooLarge.plan, null);
  assert.ok(diagnosticFor(tooLarge, /input limit/));
  assert.equal(hugeExpansion.plan, null);
  assert.ok(diagnosticFor(hugeExpansion, /expansion exceeds/));
});

test('returns frozen copies and does not mutate caller-owned filenames', () => {
  const source = 'app: main.c\n\tcc main.c -o app\n';
  const names = ['main.c'];
  const result = parseMakefile(source, names);
  names[0] = 'changed.c';

  assert.equal(result.plan?.entry, 'main.c');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.diagnostics), true);
  assert.equal(Object.isFrozen(result.plan), true);
  assert.equal(Object.isFrozen(result.plan?.translationUnits), true);
  assert.deepEqual(parseMakefile(source, ['main.c']), result);
});
