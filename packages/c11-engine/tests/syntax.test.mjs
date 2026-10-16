import assert from 'node:assert/strict';
import test from 'node:test';
import { C_KEYWORDS, C_TYPE_KEYWORDS, scanC } from '../dist/syntax.js';

function scan(source) {
  const tokens = Array.from(scanC(source));
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

const significant = (source) => scan(source)
  .filter(({ kind }) => kind !== 'whitespace')
  .map((token) => ({ ...token, text: source.slice(token.start, token.end) }));

test('C syntax scanning preserves every UTF-16 source unit, even incomplete or invalid editor input', () => {
  const sources = [
    '', '\t \r\n\n\r',
    'int café = 1;\r\n\t// 日本語 😀 <>&\r\nreturn café;',
    '"<img src=x onerror=alert(1)> & </span>"',
    '@ ` $ \u0000 😀',
    '/* unterminated <>&', '"unfinished\\', "L'unfinished",
    '#', '#  include <stdio.h', '#define TEXT "incomplete',
  ];
  for (const source of sources) scan(source);
});

test('scanner coordinates count physical CRLF, LF and CR lines without changing source offsets', () => {
  const source = 'int\tmain\r\n// 😀\r\n  return\n42;\rx';
  const tokens = significant(source);
  for (const [text, line, column] of [
    ['int', 1, 1], ['main', 1, 5], ['// 😀', 2, 1],
    ['return', 3, 3], ['42', 4, 1], [';', 4, 3], ['x', 5, 1],
  ]) {
    const token = tokens.find((candidate) => candidate.text === text);
    assert.ok(token, text);
    assert.deepEqual([token.line, token.column], [line, column], text);
    assert.equal(token.start, source.indexOf(text), text);
  }
});

test('preprocessing numbers retain suffixes, exponent signs and malformed suffixes as one token', () => {
  const numbers = ['0', '077', '0xFFu', '4294967295UL', '1.25f', '.5', '1e-9', '0x1.fp+3L', '12invalid'];
  const tokens = significant(numbers.join(' '));
  assert.deepEqual(tokens.map(({ text }) => text), numbers);
  assert.ok(tokens.every(({ kind }) => kind === 'number'));
  assert.deepEqual(significant('1+2 3-4').map(({ text }) => text), ['1', '+', '2', '3', '-', '4']);
});

test('C punctuators use maximal munch and never split multicharacter operators', () => {
  const operators = ['>>=', '<<=', '...', '++', '--', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '##'];
  const tokens = significant(operators.join(' '));
  assert.deepEqual(tokens.map(({ text }) => text), operators);
  assert.ok(tokens.every(({ kind }) => kind === 'symbol'));
});

test('quoted tokens keep C prefixes and escaped quotes, ignoring comment markers in their contents', () => {
  const literals = ['"// int /* return */"', 'u8"café"', 'L"wide"', 'u"utf16"', 'U"utf32"', "'\\''", "L'c'", "u'c'", "U'c'"];
  const tokens = significant(literals.join(' '));
  assert.deepEqual(tokens.map(({ text }) => text), literals);
  assert.ok(tokens.every(({ kind, closed }) => ['string', 'character'].includes(kind) && closed === true));
  assert.equal(tokens[0].kind, 'string');
  assert.equal(tokens[5].kind, 'character');
});

test('unfinished strings, characters and comments are valid scan results and recover at the next line', () => {
  for (const [source, kind] of [
    ['"unfinished\\', 'string'], ["u'partial", 'character'],
    ['/* unfinished', 'block-comment'], ['// unfinished', 'line-comment'],
  ]) {
    const tokens = significant(source);
    assert.equal(tokens.length, 1, source);
    assert.equal(tokens[0].kind, kind, source);
    assert.equal(tokens[0].closed, false, source);
  }
  for (const source of ['"unfinished\r\nint', "'unfinished\nint"]) {
    const tokens = significant(source);
    assert.equal(tokens[0].closed, false);
    assert.equal(tokens.at(-1).text, 'int');
    assert.equal(tokens.at(-1).kind, 'identifier');
    assert.equal(tokens.at(-1).line, 2);
  }
});

test('escaped physical newlines continue line comments and string literals', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const comment = `// first\\${newline}return 42;`;
    const commentTokens = significant(comment);
    assert.equal(commentTokens.length, 1);
    assert.equal(commentTokens[0].kind, 'line-comment');
    const string = `"first\\${newline}second"`;
    const stringTokens = significant(string);
    assert.equal(stringTokens.length, 1);
    assert.equal(stringTokens[0].kind, 'string');
    assert.equal(stringTokens[0].closed, true);
  }
});

test('directive tokens appear only at the start of a logical line, with whitespace and comments allowed', () => {
  const source = '  #include <stdio.h>\n/* lead */ # define X 42\nint x # invalid;';
  const tokens = significant(source);
  assert.deepEqual(tokens.filter(({ kind }) => kind === 'preprocessor').map(({ text }) => text), ['#include', '# define']);
  const ordinaryHash = tokens.find(({ start }) => start === source.indexOf('# invalid'));
  assert.equal(ordinaryHash.kind, 'symbol');
});

test('include header names are single string tokens and recover from an unfinished header at a newline', () => {
  const source = '#include /* note */ <path/return.h>\n#include <odd/*name.h>\n#include <unfinished\r\nint';
  const tokens = significant(source);
  const headers = tokens.filter(({ kind }) => kind === 'string');
  assert.deepEqual(headers.map(({ text, closed }) => [text, closed]), [
    ['<path/return.h>', true], ['<odd/*name.h>', true], ['<unfinished', false],
  ]);
  assert.equal(tokens.at(-1).text, 'int');
  assert.equal(tokens.at(-1).kind, 'identifier');
  assert.equal(tokens.at(-1).line, 4);
});

test('shared keyword tables cover C11 and are safe to reuse without mutation', () => {
  const standard = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local'.split(' ');
  assert.deepEqual([...C_KEYWORDS].sort(), standard.sort());
  for (const keyword of ['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool', '_Complex', '_Imaginary']) {
    assert.ok(C_TYPE_KEYWORDS.includes(keyword), keyword);
  }
  assert.ok(Object.isFrozen(C_KEYWORDS));
  assert.ok(Object.isFrozen(C_TYPE_KEYWORDS));
});
