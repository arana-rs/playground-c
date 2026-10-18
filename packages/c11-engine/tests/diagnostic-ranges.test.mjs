import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSyntax, prepare } from '../dist/core/index.js';

const project = (source, name = 'main.c') => ({ entry: name, files: [{ name, source }] });

function syntaxDiagnostics(source, name = 'main.c') {
  const result = analyzeSyntax(project(source, name));
  assert.equal(result.kind, 'error', JSON.stringify(result));
  return result.diagnostics;
}

test('syntax diagnostics expose exact token spans and a related opening-parenthesis range', () => {
  const source = 'int main(void) { int total = (10 + 5; }';
  const diagnostics = syntaxDiagnostics(source);
  const semicolon = source.indexOf(';', source.indexOf('5'));
  const opening = source.indexOf('(', source.indexOf('int total'));
  const diagnostic = diagnostics.find(item => item.column === semicolon + 1);

  assert.ok(diagnostic, JSON.stringify(diagnostics));
  assert.equal(diagnostic.message, 'Expected closing «)» before «;».');
  assert.deepEqual(
    [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.endLine, diagnostic.endColumn],
    ['main.c', 1, semicolon + 1, 1, semicolon + 2],
  );
  assert.deepEqual(diagnostic.related, [{
    message: 'Opening parenthesis for this expression.',
    file: 'main.c',
    line: 1,
    column: opening + 1,
    endLine: 1,
    endColumn: semicolon + 1,
  }]);
});

test('expression boundaries report the expected closer from the top open delimiter', () => {
  const cases = [
    {
      source: 'int main(void) { return (10 + 5; }',
      expected: ')',
      opener: '(',
      relatedMessage: 'Opening parenthesis for this expression.',
    },
    {
      source: 'int main(void) { return sum(10, 5; }',
      expected: ')',
      opener: '(',
      openerAfter: 'sum',
      relatedMessage: 'Opening parenthesis for this function call.',
    },
    {
      source: 'int main(void) { return values[2; }',
      expected: ']',
      opener: '[',
      relatedMessage: 'Opening subscript bracket for this expression.',
    },
    {
      source: 'int main(void) { for (int i = 0; (i < 3; i++) { } return 0; }',
      expected: ')',
      opener: '(',
      openerAfter: '(i < 3',
      boundaryAfter: '(i < 3',
      relatedMessage: 'Opening parenthesis for this expression.',
    },
    {
      source: 'int main(void) { return values[sum(1; }',
      expected: ')',
      opener: '(',
      openerAfter: 'sum',
      relatedMessage: 'Opening parenthesis for this function call.',
    },
  ];

  for (const { source, expected, opener, openerAfter = 'return', boundaryAfter = openerAfter, relatedMessage } of cases) {
    const diagnostics = syntaxDiagnostics(source);
    const opening = source.indexOf(opener, source.indexOf(openerAfter));
    const boundary = source.indexOf(';', source.indexOf(boundaryAfter));
    const diagnostic = diagnostics.find(({ column }) => column === boundary + 1);

    assert.ok(diagnostic, JSON.stringify(diagnostics));
    assert.equal(diagnostic.message, `Expected closing «${expected}» before «;».`);
    assert.deepEqual(
      [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.endLine, diagnostic.endColumn],
      ['main.c', 1, boundary + 1, 1, boundary + 2],
    );
    assert.deepEqual(diagnostic.related, [{
      message: relatedMessage,
      file: 'main.c',
      line: 1,
      column: opening + 1,
      endLine: 1,
      endColumn: boundary + 1,
    }]);
  }
});

test('a closing brace boundary reports the expected closer for open groups and subscripts', () => {
  const cases = [
    {
      source: 'int main(void) { return (1 + 2 }',
      expected: ')',
      opener: '(',
      relatedMessage: 'Opening parenthesis for this expression.',
    },
    {
      source: 'int main(void) { return values[2 }',
      expected: ']',
      opener: '[',
      relatedMessage: 'Opening subscript bracket for this expression.',
    },
  ];

  for (const { source, expected, opener, relatedMessage } of cases) {
    const diagnostics = syntaxDiagnostics(source);
    const opening = source.indexOf(opener, source.indexOf('return'));
    const boundary = source.indexOf('}', source.indexOf('return'));
    const diagnostic = diagnostics.find(({ column }) => column === boundary + 1);

    assert.ok(diagnostic, JSON.stringify(diagnostics));
    assert.equal(diagnostic.message, `Expected closing «${expected}» before «}».`);
    assert.deepEqual(
      [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.endLine, diagnostic.endColumn],
      ['main.c', 1, boundary + 1, 1, boundary + 2],
    );
    assert.deepEqual(diagnostic.related, [{
      message: relatedMessage,
      file: 'main.c',
      line: 1,
      column: opening + 1,
      endLine: 1,
      endColumn: boundary + 1,
    }]);
  }
});

test('mismatched closing delimiters report the closer required by the top marker', () => {
  const cases = [
    { expression: '(1]', unexpected: ']', expected: ')', opener: '(', relatedMessage: 'Opening parenthesis for this expression.' },
    { expression: 'call(1]', unexpected: ']', expected: ')', opener: '(', relatedMessage: 'Opening parenthesis for this function call.' },
    { expression: 'values[1)', unexpected: ')', expected: ']', opener: '[', relatedMessage: 'Opening subscript bracket for this expression.' },
    { expression: 'values[call(1]', unexpected: ']', expected: ')', opener: '(', relatedMessage: 'Opening parenthesis for this function call.' },
  ];

  for (const { expression, unexpected, expected, opener, relatedMessage } of cases) {
    const source = `int main(void) { return ${expression}; }`;
    const diagnostics = syntaxDiagnostics(source);
    const expressionStart = source.indexOf(expression);
    const opening = source.indexOf(opener, expressionStart);
    const boundary = source.indexOf(unexpected, opening + 1);
    const diagnostic = diagnostics.find(({ column }) => column === boundary + 1);

    assert.ok(diagnostic, JSON.stringify(diagnostics));
    assert.equal(diagnostic.message, `Expected closing «${expected}».`);
    assert.deepEqual(
      [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.endLine, diagnostic.endColumn],
      ['main.c', 1, boundary + 1, 1, boundary + 2],
    );
    assert.deepEqual(diagnostic.related, [{
      message: relatedMessage,
      file: 'main.c',
      line: 1,
      column: opening + 1,
      endLine: 1,
      endColumn: boundary + 1,
    }]);
  }
});

test('expected-closer messages preserve missing-operator and missing-expression diagnostics', () => {
  const missingOperator = syntaxDiagnostics('int main(void) { return 1 2; }');
  assert.equal(missingOperator[0].message, 'Missing operator before «2».');

  for (const source of [
    'int main(void) { return (1 + ; }',
    'int main(void) { return (]; }',
  ]) {
    assert.equal(syntaxDiagnostics(source)[0].message, 'Expected a C expression.');
  }
});

test('multi-character token ranges preserve UTF-16 columns across tabs and CRLF', () => {
  const source = 'int main(void) {\r\n\tconst char *label = "😀"; int value = return;\r\n}';
  const sourceLine = source.split('\r\n')[1];
  const returnColumn = sourceLine.indexOf('return') + 1;
  const diagnostic = syntaxDiagnostics(source).find(item => item.line === 2 && item.column === returnColumn);

  assert.ok(diagnostic, JSON.stringify(syntaxDiagnostics(source)));
  assert.equal(diagnostic.endLine, 2);
  assert.equal(diagnostic.endColumn, returnColumn + 'return'.length);
});

test('a later matching parenthesis does not turn a local syntax error into an unclosed-range diagnostic', () => {
  const diagnostics = syntaxDiagnostics('int main(void) { return (10 + ; 5); }');

  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics.some(({ message }) => /unclosed|missing closing parenthesis/i.test(message)), false);
  assert.equal(diagnostics.flatMap(item => item.related ?? []).some(({ message }) => /unclosed/i.test(message)), false);
});

test('EOF diagnostics keep a safe related range without inventing a primary token span', () => {
  const source = 'int main(void) { return (10 + 5';
  const diagnostics = syntaxDiagnostics(source);
  const eofDiagnostic = diagnostics.find(({ message }) => /Missing closing parenthesis/i.test(message));
  const opening = source.indexOf('(', source.indexOf('return'));

  assert.ok(eofDiagnostic, JSON.stringify(diagnostics));
  assert.equal(eofDiagnostic.message, 'Missing closing parenthesis or subscript bracket.');
  assert.equal(eofDiagnostic.endLine, undefined);
  assert.equal(eofDiagnostic.endColumn, undefined);
  assert.deepEqual(eofDiagnostic.related, [{
    message: 'Unclosed parenthesized expression starts here.',
    file: 'main.c',
    line: 1,
    column: opening + 1,
    endLine: 1,
    endColumn: source.length + 1,
  }]);
});

test('macro, #line, and included-source boundaries suppress unsafe range links', () => {
  const macroSource = '#define BAD return\nint value = BAD;';
  const macroDiagnostic = syntaxDiagnostics(macroSource).find(item => item.line === 2);
  assert.ok(macroDiagnostic);
  assert.equal(macroDiagnostic.endLine, undefined);
  assert.equal(macroDiagnostic.endColumn, undefined);

  const lineSource = '#line 40 "mapped.c"\nint value = return;';
  const lineDiagnostic = syntaxDiagnostics(lineSource).find(item => item.file === 'mapped.c');
  assert.ok(lineDiagnostic);
  assert.equal(lineDiagnostic.line, 40);
  assert.equal(lineDiagnostic.endLine, undefined);
  assert.equal(lineDiagnostic.endColumn, undefined);

  const included = analyzeSyntax({
    entry: 'main.c',
    files: [
      { name: 'main.c', source: '#include "header.h"\n;\n}' },
      { name: 'header.h', source: 'int main(void) { return (10 + 5' },
    ],
  });
  assert.equal(included.kind, 'error', JSON.stringify(included));
  const boundaryDiagnostic = included.diagnostics.find(item => item.file === 'main.c' && item.line === 2);
  assert.ok(boundaryDiagnostic, JSON.stringify(included));
  assert.equal(boundaryDiagnostic.related, undefined);
});

test('ordinary prepare keeps its legacy syntax diagnostic fields', () => {
  const source = 'int main(void) { int total = (10 + 5; }';
  const result = prepare(project(source));

  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.deepEqual(result.diagnostics[0], {
    code: 'SYNTAX_ERROR',
    message: 'Expected closing «)» before «;».',
    file: 'main.c',
    line: 1,
    column: source.indexOf(';', source.indexOf('5')) + 1,
  });

  const mismatchSource = 'int main(void) { return values[2); }';
  const mismatch = prepare(project(mismatchSource));
  assert.equal(mismatch.kind, 'prepare-error', JSON.stringify(mismatch));
  assert.deepEqual(mismatch.diagnostics[0], {
    code: 'SYNTAX_ERROR',
    message: 'Expected closing «]».',
    file: 'main.c',
    line: 1,
    column: mismatchSource.indexOf(')', mismatchSource.indexOf('values')) + 1,
  });
});
