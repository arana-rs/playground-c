import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES } from '@playground/c11-engine/core';
import { C_KEYWORDS, C_TYPE_KEYWORDS } from '@playground/c11-engine/syntax';
import { evaluateEditorTextReplacement } from '../src/editor/operations.ts';
import { getCompletionSuggestions } from '../src/editor/completionProvider.ts';

const completion = (source, cursorOffset, trigger = 'manual') =>
  getCompletionSuggestions({ source, cursorOffset, trigger });

const supportedFunctions = new Set([
  ...CAPABILITIES.stdioFunctions,
  ...CAPABILITIES.stdlibFunctions,
  ...CAPABILITIES.stringFunctions,
  ...CAPABILITIES.timeFunctions,
  ...CAPABILITIES.ctypeFunctions,
  ...CAPABILITIES.inttypesFunctions,
  ...CAPABILITIES.mathFunctions,
]);

test('automatic identifier completion waits for two prefix characters and replaces the full identifier', () => {
  const source = 'prXYZintf();';
  assert.equal(completion(source, 1, 'automatic'), null);

  const result = completion(source, 2, 'automatic');
  assert.ok(result);
  assert.equal(result.replaceStart, 0);
  assert.equal(result.replaceEnd, 'prXYZintf'.length);
  assert.deepEqual(result.options, ['printf']);
});

test('identifier completion uses the canonical C keyword and type catalogs', () => {
  const result = completion('void', 2, 'automatic');
  assert.ok(result);
  assert.equal(result.replaceStart, 0);
  assert.equal(result.replaceEnd, 4);
  assert.ok(result.options.includes('void'));

  const manual = completion('', 0, 'manual');
  assert.ok(manual);
  assert.equal(manual.options.length, 6);
  assert.deepEqual(manual.options, [...manual.options].sort());
  assert.ok(manual.options.every((name) =>
    C_KEYWORDS.includes(name) || C_TYPE_KEYWORDS.includes(name) || supportedFunctions.has(name),
  ));
});

test('the catalog contains supported engine functions and excludes user-defined names', () => {
  const source = 'void myFunction(void) { myF; }';
  const result = completion(source, source.indexOf('myF') + 3, 'manual');
  assert.equal(result, null);
  const variableSource = 'int myVariable; myV;';
  assert.equal(completion(variableSource, variableSource.indexOf('myV;') + 3, 'manual'), null);
  assert.equal(completion('__c11_assert_fail', '__c11_assert_fail'.length, 'manual'), null);

  const standard = completion('str', 3, 'manual');
  assert.ok(standard);
  assert.ok(standard.options.length <= 6);
  assert.ok(standard.options.every((name) => supportedFunctions.has(name) || C_KEYWORDS.includes(name)));
});

test('an incomplete include directive completes from the hash while preserving its spacing', () => {
  for (const source of ['#inc', '# inc', '# /*comment*/ inc']) {
    const cursorOffset = source.length;
    const result = completion(source, cursorOffset, 'automatic');
    assert.ok(result, source);
    assert.deepEqual(result.options, ['include ']);
    assert.equal(source.slice(result.replaceStart, result.replaceEnd), source.slice(source.indexOf('inc')));
    assert.equal(
      source.slice(0, result.replaceStart) + result.options[0] + source.slice(result.replaceEnd),
      source.replace(/inc$/, 'include '),
    );
  }

  const source = '#include';
  assert.equal(completion(source, source.length, 'automatic'), null);
});

test('header completion replaces the whole angled name while retaining both delimiters', () => {
  const source = '#include <stdTAIL.h>';
  const cursorOffset = source.indexOf('std') + 3;
  const result = completion(source, cursorOffset, 'manual');
  assert.ok(result);
  assert.equal(source.slice(result.replaceStart - 1, result.replaceStart), '<');
  assert.equal(source.slice(result.replaceStart, result.replaceEnd), 'stdTAIL.h');
  assert.equal(source.slice(result.replaceEnd, result.replaceEnd + 1), '>');
  assert.ok(result.options.includes('stdio.h'));
  assert.ok(result.options.every((name) => CAPABILITIES.virtualHeaders.includes(name)));
  assert.equal(result.options.length, 6);
});

test('quoted and incomplete headers use only virtual header names', () => {
  const quotedSource = '#include "mathTAIL.h"';
  const quotedResult = completion(quotedSource, quotedSource.indexOf('math') + 4, 'manual');
  assert.ok(quotedResult);
  assert.equal(quotedSource.slice(quotedResult.replaceStart - 1, quotedResult.replaceStart), '"');
  assert.equal(quotedSource.slice(quotedResult.replaceStart, quotedResult.replaceEnd), 'mathTAIL.h');
  assert.equal(quotedSource.slice(quotedResult.replaceEnd, quotedResult.replaceEnd + 1), '"');
  assert.deepEqual(quotedResult.options, ['math.h']);

  const incompleteSource = '#include <std';
  const incompleteResult = completion(incompleteSource, incompleteSource.length, 'automatic');
  assert.ok(incompleteResult);
  assert.equal(incompleteResult.replaceStart, '#include <'.length);
  assert.equal(incompleteResult.replaceEnd, incompleteSource.length);
  assert.ok(incompleteResult.options.includes('stdio.h'));
});

test('spaced include directives complete real headers and retain an existing closer', () => {
  const source = '# include <stTAIL.h>';
  const cursorOffset = source.indexOf('st') + 2;
  const result = completion(source, cursorOffset, 'manual');
  assert.ok(result);
  assert.equal(source.slice(result.replaceStart, result.replaceEnd), 'stTAIL.h');
  assert.equal(source[result.replaceStart - 1], '<');
  assert.equal(source[result.replaceEnd], '>');
  assert.ok(result.options.includes('stdio.h'));
  assert.ok(result.options.every((name) => CAPABILITIES.virtualHeaders.includes(name)));
});

test('accepting an include directive inserts one trailing space and places the caret after it', () => {
  const directiveSource = '#incl';
  const directiveCursor = directiveSource.length;
  const directive = completion(directiveSource, directiveCursor, 'automatic');
  assert.ok(directive);
  assert.deepEqual(directive.options, ['include ']);
  const completedDirective = evaluateEditorTextReplacement({
    text: directiveSource,
    selection: { start: directiveCursor, end: directiveCursor, direction: 'none' },
    pairs: [],
  }, directive.replaceStart, directive.replaceEnd, directive.options[0]);
  assert.equal(completedDirective?.snapshot.text, '#include ');
  assert.equal(completedDirective?.snapshot.selection.start, '#include '.length);

  const spacedSource = '#incl <stdio.h>';
  const spacedCursor = spacedSource.indexOf('incl') + 'incl'.length;
  const spacedDirective = completion(spacedSource, spacedCursor, 'automatic');
  assert.ok(spacedDirective);
  assert.deepEqual(spacedDirective.options, ['include ']);
  const completedSpacedDirective = evaluateEditorTextReplacement({
    text: spacedSource,
    selection: { start: spacedCursor, end: spacedCursor, direction: 'none' },
    pairs: [],
  }, spacedDirective.replaceStart, spacedDirective.replaceEnd, spacedDirective.options[0]);
  assert.equal(completedSpacedDirective?.snapshot.text, '#include <stdio.h>');
  assert.equal(completedSpacedDirective?.snapshot.selection.start, '#include '.length);

  const adjacentSource = '#incl<stdio.h>';
  const adjacentCursor = adjacentSource.indexOf('incl') + 'incl'.length;
  const adjacentDirective = completion(adjacentSource, adjacentCursor, 'automatic');
  assert.ok(adjacentDirective);
  assert.deepEqual(adjacentDirective.options, ['include']);
  const completedAdjacentDirective = evaluateEditorTextReplacement({
    text: adjacentSource,
    selection: { start: adjacentCursor, end: adjacentCursor, direction: 'none' },
    pairs: [],
  }, adjacentDirective.replaceStart, adjacentDirective.replaceEnd, adjacentDirective.options[0]);
  assert.equal(completedAdjacentDirective?.snapshot.text, '#include<stdio.h>');
  assert.equal(completedAdjacentDirective?.snapshot.selection.start, '#include'.length);
});

test('accepting header suggestions keeps delimiters and places the caret after inserted text', () => {
  const headerSource = '#include "mathTAIL.h"';
  const headerCursor = headerSource.indexOf('math') + 4;
  const header = completion(headerSource, headerCursor, 'manual');
  assert.ok(header);
  assert.ok(header.options.includes('math.h'));
  const completedHeader = evaluateEditorTextReplacement({
    text: headerSource,
    selection: { start: headerCursor, end: headerCursor, direction: 'none' },
    pairs: [],
  }, header.replaceStart, header.replaceEnd, 'math.h');
  assert.equal(completedHeader?.snapshot.text, '#include "math.h"');
  assert.equal(completedHeader?.snapshot.selection.start, headerSource.indexOf('math') + 'math.h'.length);
  assert.equal(completedHeader?.snapshot.text[completedHeader.snapshot.selection.start], '"');
});

test('a comment between # and include still completes quoted and angled virtual headers', () => {
  const angledSource = '# /*comment*/ include <stdTAIL.h>';
  const angledResult = completion(angledSource, angledSource.indexOf('std') + 3, 'manual');
  assert.ok(angledResult);
  assert.equal(angledSource.slice(angledResult.replaceStart - 1, angledResult.replaceStart), '<');
  assert.equal(angledSource.slice(angledResult.replaceStart, angledResult.replaceEnd), 'stdTAIL.h');
  assert.equal(angledSource.slice(angledResult.replaceEnd, angledResult.replaceEnd + 1), '>');
  assert.ok(angledResult.options.includes('stdio.h'));
  assert.ok(angledResult.options.every((name) => CAPABILITIES.virtualHeaders.includes(name)));

  const quotedSource = '# /*comment*/ include "mathTAIL.h"';
  const quotedResult = completion(quotedSource, quotedSource.indexOf('math') + 4, 'manual');
  assert.ok(quotedResult);
  assert.equal(quotedSource.slice(quotedResult.replaceStart - 1, quotedResult.replaceStart), '"');
  assert.equal(quotedSource.slice(quotedResult.replaceStart, quotedResult.replaceEnd), 'mathTAIL.h');
  assert.equal(quotedSource.slice(quotedResult.replaceEnd, quotedResult.replaceEnd + 1), '"');
  assert.deepEqual(quotedResult.options, ['math.h']);
});

test('comments, ordinary strings, and character literals suppress completion through EOF', () => {
  for (const source of ['// printf', '/* printf', '"printf', "'p"]) {
    assert.equal(completion(source, source.length, 'manual'), null, source);
  }

  assert.equal(completion('const char *text = "printf";', 23, 'manual'), null);
  assert.equal(completion('/* #include <std> */', 15, 'manual'), null);
  assert.equal(completion('// #include <std', 16, 'manual'), null);
});

test('an include-looking string inside a C string is not a header context', () => {
  const source = 'const char *text = "#include <std>";';
  const cursorOffset = source.indexOf('std') + 2;
  assert.equal(completion(source, cursorOffset, 'manual'), null);
});

test('manual completion accepts an empty prefix at a code position and caps deterministic results at six', () => {
  const first = completion('int value; ', 'int value; '.length, 'manual');
  const second = completion('int value; ', 'int value; '.length, 'manual');
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.equal(first.replaceStart, first.replaceEnd);
  assert.equal(first.options.length, 6);
});

test('an automatic header request also requires two prefix characters', () => {
  const shortSource = '#include <s';
  assert.equal(completion(shortSource, shortSource.length, 'automatic'), null);

  const source = '#include <st';
  const result = completion(source, source.length, 'automatic');
  assert.ok(result);
  assert.ok(result.options.every((name) => name.startsWith('s')));
});
