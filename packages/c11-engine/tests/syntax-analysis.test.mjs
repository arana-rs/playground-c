import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSyntax, CAPABILITIES, prepare } from '../dist/core/index.js';

const project = (source, name = 'syntax.c') => ({ entry: name, files: [{ name, source }] });

test('syntax analysis accepts valid translation units without main or linking', () => {
  assert.equal(CAPABILITIES.syntaxAnalysis, 'preprocess-and-parse-without-linking-or-execution; up-to-20-parser-diagnostics-with-boundary-recovery; safe-token-ranges-and-related-delimiter-locations');
  const withoutMain = analyzeSyntax(project('#include <stddef.h>\ntypedef unsigned long Word;\nWord read_word(Word value) { return value; }'));
  assert.equal(withoutMain.kind, 'ok', JSON.stringify(withoutMain));
  assert.deepEqual(withoutMain.diagnostics, []);

  const duplicateAcrossUnits = analyzeSyntax({
    entry: 'main.c',
    translationUnits: ['main.c', 'helper.c'],
    files: [
      { name: 'main.c', source: 'int same(void) { return 1; }' },
      { name: 'helper.c', source: 'int same(void) { return 2; }' },
    ],
  });
  assert.equal(duplicateAcrossUnits.kind, 'ok', JSON.stringify(duplicateAcrossUnits));
});

test('syntax analysis retains the parser requirement for an external declaration', () => {
  for (const source of ['', '/* comment only */']) {
    const result = analyzeSyntax(project(source));
    assert.equal(result.kind, 'error', JSON.stringify(result));
    assert.equal(result.diagnostics[0].code, 'SYNTAX_ERROR');
    assert.match(result.diagnostics[0].message, /no external declarations/);
  }
});

test('syntax analysis recovers two independent statements within a function', () => {
  const result = analyzeSyntax(project(`int main(void) {
    int first = ;
    int second = ;
    return 0;
  }`));
  assert.equal(result.kind, 'error', JSON.stringify(result));
  assert.equal(result.truncated, false);
  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['SYNTAX_ERROR', 'SYNTAX_ERROR']);
  assert.deepEqual(result.diagnostics.map(({ line }) => line), [2, 3]);
});

test('statement recovery skips a malformed if branch and resumes at the next statement', () => {
  const result = analyzeSyntax(project(`int main(void) {
    if () return 1; else return 0;
    return 2;
  }`));
  assert.equal(result.kind, 'error', JSON.stringify(result));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'SYNTAX_ERROR');
});

test('statement recovery resumes at a declaration after a missing semicolon', () => {
  const result = analyzeSyntax(project(`int main(void) {
    int first = 1
    int second = ;
    return 0;
  }`));
  assert.equal(result.kind, 'error', JSON.stringify(result));
  assert.equal(result.diagnostics.length, 2);
  assert.deepEqual(result.diagnostics.map(({ line }) => line), [3, 3]);
});

test('syntax analysis recovers across external declarations and keeps mapped locations', () => {
  const result = analyzeSyntax(project(`#line 40 "mapped.c"
int first = ;
int second = ;
int helper(void) { return 0; }`));
  assert.equal(result.kind, 'error', JSON.stringify(result));
  assert.deepEqual(result.diagnostics.map(({ file, line }) => [file, line]), [['mapped.c', 40], ['mapped.c', 41]]);
});

test('external recovery consumes aggregate declarators before resuming at later declarations', () => {
  const result = analyzeSyntax(project(`struct S { int x; } bad = ;
int first = ;
int second = ;`));
  assert.equal(result.kind, 'error', JSON.stringify(result));
  assert.deepEqual(result.diagnostics.map(({ code, line }) => [code, line]), [
    ['SYNTAX_ERROR', 1], ['SYNTAX_ERROR', 2], ['SYNTAX_ERROR', 3],
  ]);
});

test('syntax analysis leaves semantic name resolution to prepare', () => {
  const source = 'int helper(void) { return missing_name; }';
  const syntax = analyzeSyntax(project(source));
  assert.equal(syntax.kind, 'ok', JSON.stringify(syntax));
  const preparation = prepare(project(source));
  assert.equal(preparation.kind, 'prepare-error');
  assert.equal(preparation.diagnostics[0].code, 'UNKNOWN_IDENTIFIER');
});

test('syntax analysis returns preprocessing diagnostics and recovers an unmatched block without hanging', () => {
  const unterminatedString = analyzeSyntax(project('int value = "unfinished;'));
  assert.equal(unterminatedString.kind, 'error');
  assert.equal(unterminatedString.diagnostics.length, 1);

  const unmatchedBlock = analyzeSyntax(project('int main(void) { return 0;'));
  assert.equal(unmatchedBlock.kind, 'error', JSON.stringify(unmatchedBlock));
  assert.equal(unmatchedBlock.diagnostics.length, 1);
  assert.match(unmatchedBlock.diagnostics[0].message, /Missing closing \}/);

  const statementAndBlockErrors = analyzeSyntax(project('int main(void) { int value = ;'));
  assert.equal(statementAndBlockErrors.kind, 'error', JSON.stringify(statementAndBlockErrors));
  assert.deepEqual(statementAndBlockErrors.diagnostics.map(({ message }) => message), [
    'Missing expression or operand.', 'Missing closing } for block.',
  ]);

  const unterminatedComment = analyzeSyntax(project('int value; /* unfinished'));
  assert.equal(unterminatedComment.kind, 'error');
  assert.equal(unterminatedComment.diagnostics.length, 1);
});

test('failed declarations roll back typedef and aggregate parser state before recovery', () => {
  const typedefResult = analyzeSyntax(project(`typedef int First, Broken = 1;
int First;
int later = ;`));
  assert.equal(typedefResult.kind, 'error', JSON.stringify(typedefResult));
  assert.deepEqual(typedefResult.diagnostics.map(({ line }) => line), [1, 3]);

  const aggregateResult = analyzeSyntax(project(`struct Item;
struct Item { int value; } bad = ;
struct Item { int next; } good;
int later = ;`));
  assert.equal(aggregateResult.kind, 'error', JSON.stringify(aggregateResult));
  assert.deepEqual(aggregateResult.diagnostics.map(({ line }) => line), [2, 4]);

  const nestedResult = analyzeSyntax(project(`int helper(void) {
  {
    struct Local { int value; } first = ;
    struct Local { int next; } second;
  }
  return 0;
}`));
  assert.equal(nestedResult.kind, 'error', JSON.stringify(nestedResult));
  assert.equal(nestedResult.diagnostics.length, 1);
  assert.equal(nestedResult.diagnostics[0].line, 3);

  const globalResult = analyzeSyntax(project(`int value;
int value = 2, other = ;
int value = 3;`));
  assert.equal(globalResult.kind, 'error', JSON.stringify(globalResult));
  assert.deepEqual(globalResult.diagnostics.map(({ line }) => line), [2]);

  const linkageResult = analyzeSyntax(project(`static int value, = 1;
extern int value;`));
  assert.equal(linkageResult.kind, 'error', JSON.stringify(linkageResult));
  assert.deepEqual(linkageResult.diagnostics.map(({ line }) => line), [1]);
});

test('syntax analysis reuses preparation budgets and reports a bounded diagnostic count', () => {
  const projectValue = project('int main(void) { return 0; }');
  const limited = analyzeSyntax(projectValue, { limits: { maxTokens: 2 } });
  assert.equal(limited.kind, 'limit');
  assert.equal(limited.stage, 'syntax');
  assert.equal(limited.resource, 'maxTokens');

  const depthLimited = analyzeSyntax(project('int main(void) { { return 0; } }'), { limits: { maxDepth: 1 } });
  assert.equal(depthLimited.kind, 'limit', JSON.stringify(depthLimited));
  if (depthLimited.kind === 'limit') {
    assert.equal(depthLimited.resource, 'maxDepth');
    assert.equal(depthLimited.stage, 'syntax');
  }

  const manyErrors = analyzeSyntax(project(Array.from({ length: 25 }, (_, index) => `int value${index} = ;`).join('\n')));
  assert.equal(manyErrors.kind, 'error');
  assert.equal(manyErrors.diagnostics.length, 20);
  assert.equal(manyErrors.truncated, true);
});
