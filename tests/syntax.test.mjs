import assert from 'node:assert/strict';
import test from 'node:test';
import { C_KEYWORDS, C_TYPE_KEYWORDS } from '@playground/c11-engine/syntax';
import { getCContext } from '../src/editor/context.ts';
import { highlightC } from '../src/editor/highlight.ts';
import { applyEditorCommand, reconcileNativeEdit } from '../src/editor/operations.ts';

function highlight(source) {
  const tokens = highlightC(source);
  let offset = 0;
  for (const token of tokens) {
    assert.equal(token.start, offset, `missing or overlapping source at ${offset}`);
    assert.ok(token.end > token.start && token.end <= source.length);
    offset = token.end;
  }
  assert.equal(offset, source.length);
  assert.equal(tokens.map(({ start, end }) => source.slice(start, end)).join(''), source);
  return tokens;
}

function kindAt(source, text, occurrence = 0) {
  let offset = -1;
  for (let count = 0; count <= occurrence; count += 1) offset = source.indexOf(text, offset + 1);
  assert.ok(offset >= 0, `${JSON.stringify(text)} not found in source`);
  const token = highlight(source).find(({ start, end }) => start <= offset && offset < end);
  assert.ok(token, text);
  return token.kind;
}

test('editor highlights every C11 keyword and distinguishes built-in type keywords', () => {
  for (const keyword of C_KEYWORDS) {
    const kind = kindAt(keyword, keyword);
    assert.equal(kind, C_TYPE_KEYWORDS.includes(keyword) ? 'type' : 'keyword', keyword);
  }
  assert.equal(kindAt('integer returnValue _Static_assertion', 'integer'), 'plain');
  assert.equal(kindAt('integer returnValue _Static_assertion', 'returnValue'), 'plain');
  assert.equal(kindAt('integer returnValue _Static_assertion', '_Static_assertion'), 'plain');
});

test('editor identifies function names, numeric literals, operators and punctuation in ordinary C code', () => {
  const source = 'static int twice(int n) { if (n <= 0) return 0; return twice(n - 1) + 0x1.fp+3L; }';
  for (const [text, kind] of [
    ['static', 'keyword'], ['int', 'type'], ['twice', 'function'], ['if', 'keyword'],
    ['n)', 'plain'], ['<=', 'operator'], ['0', 'number'], ['return', 'keyword'],
    ['-', 'operator'], ['+', 'operator'], ['0x1.fp+3L', 'number'], ['{', 'punctuation'], [';', 'punctuation'],
  ]) assert.equal(kindAt(source, text), kind, text);
  assert.equal(kindAt('work /* comment */ (1);', 'work'), 'function');
});

test('comments and strings protect their contents from keyword, directive and operator classification', () => {
  const source = '// int return foo() #define\r\n/* double while <>& */\nchar *text = u8"if // \\\" /* return <>&";';
  for (const text of ['int', 'return', 'foo', '#define', 'double', 'while', '<>&']) {
    assert.equal(kindAt(source, text), 'comment', text);
  }
  assert.equal(kindAt(source, 'char'), 'type');
  assert.equal(kindAt(source, 'u8"'), 'string');
  assert.equal(kindAt(source, 'if //'), 'string');
  assert.equal(kindAt(source, 'return', 1), 'string');
});

test('preprocessor directives color their names and include paths while keeping C values classified', () => {
  const source = '  #include <stdio.h>\n# include "local.h"\n#define LIMIT 42UL\n#define TEXT "return"\nint x # invalid;';
  for (const text of ['#include', '# include', '#define']) assert.equal(kindAt(source, text), 'preprocessor');
  assert.equal(kindAt(source, '<stdio.h>'), 'string');
  assert.equal(kindAt(source, 'stdio'), 'string');
  assert.equal(kindAt(source, '"local.h"'), 'string');
  assert.equal(kindAt(source, '42UL'), 'number');
  assert.equal(kindAt(source, '"return"'), 'string');
  assert.notEqual(kindAt(source, '# invalid'), 'preprocessor');
});

test('highlight spans preserve hostile text, tabs, CRLF, Unicode and incomplete editing states', () => {
  const sources = [
    '', '\t\r\n\n',
    'int café = 1;\r\n\t// 日本語 😀\r\n',
    '"<img src=x onerror=alert(1)> & </span>"',
    '/* <script>alert("return")</script> & */',
    '"unfinished\\', "L'unfinished", '// return', '/* int',
    '#', '#include <stdio.h', '#define TEXT "unfinished', '@ ` \u0000',
  ];
  for (const source of sources) highlight(source);
  assert.equal(kindAt('"unfinished\\', 'unfinished'), 'string');
  assert.equal(kindAt("L'unfinished", 'unfinished'), 'string');
  assert.equal(kindAt('/* int', 'int'), 'comment');
});

test('the shared scanner preserves context after escaped physical newlines and incomplete comments', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const [source, kind] of [
      [`// comment\\${newline}continued`, 'line-comment'],
      [`"text\\${newline}continued`, 'string'],
      [`'x\\${newline}continued`, 'character'],
      [`/\\${newline}* comment`, 'block-comment'],
      [`/\\${newline}/ comment`, 'line-comment'],
    ]) assert.deepEqual(getCContext(source, source.length), { kind, escaped: false }, source);
  }
  for (const source of ['// done\n', '/* done */', '"partial\n', "'partial\r\n"]) {
    assert.deepEqual(getCContext(source, source.length), { kind: 'code', escaped: false }, source);
  }
});

test('cursor context uses only the source before the selection and keeps pending quote escape state', () => {
  const source = 'u8"text\\" // code';
  const quotedPosition = source.indexOf('"', 3);
  assert.deepEqual(getCContext(source, quotedPosition), { kind: 'string', escaped: true });
  assert.deepEqual(getCContext('\\', 1), { kind: 'code', escaped: true });
  assert.deepEqual(getCContext('\\\\', 2), { kind: 'code', escaped: false });
  assert.deepEqual(getCContext('"\\\\', 3), { kind: 'string', escaped: false });
  assert.deepEqual(getCContext('/* closed */ "later"', 2), { kind: 'block-comment', escaped: false });
});

test('native IME edits keep highlight offsets and automatic quote pair behavior coherent', () => {
  const before = applyEditorCommand({ text: '', selection: { start: 0, end: 0, direction: 'none' }, pairs: [] }, { type: 'type', character: '"' });
  const after = reconcileNativeEdit(before, '"日本語"', { start: 4, end: 4, direction: 'none' });
  highlight(after.text);
  assert.deepEqual(getCContext(after.text, after.selection.start), { kind: 'string', escaped: false });
  const skipped = applyEditorCommand(after, { type: 'type', character: '"' });
  assert.equal(skipped.text, after.text);
  assert.deepEqual(skipped.selection, { start: 5, end: 5, direction: 'none' });
  assert.equal(after.pairs.length, 1);
});
