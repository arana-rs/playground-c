import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const project = (source) => ({ entry: 'literals.c', files: [{ name: 'literals.c', source }] });

const run = (source, expected = 1) => {
  const prepared = prepare(project(source));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected, source);
  return result;
};

test('UCN UTF-8 bytes remain separate from following hexadecimal characters', () => {
  run(String.raw`int main(void) {
    const char *first = "\u00E9a";
    const char *mixed = "A\u00E9F";
    return (unsigned char)first[0] == 0xc3 && (unsigned char)first[1] == 0xa9 && first[2] == 'a' && first[3] == 0 &&
           mixed[0] == 'A' && (unsigned char)mixed[1] == 0xc3 && (unsigned char)mixed[2] == 0xa9 && mixed[3] == 'F' && mixed[4] == 0;
  }`);
});

test('escaped backslashes remain literal before UCN-looking text', () => {
  run(String.raw`int main(void) {
    const char *literal = "\\u00E9";
    const char *basic = "\\u0061";
    const char *combined = "\\\u00E9";
    const char *escape = "\x61";
    return literal[0] == 92 && literal[1] == 117 && literal[2] == 48 && literal[3] == 48 &&
           literal[4] == 69 && literal[5] == 57 && literal[6] == 0 &&
           basic[0] == 92 && basic[1] == 117 && basic[5] == 49 && basic[6] == 0 &&
           combined[0] == 92 && (unsigned char)combined[1] == 0xc3 && (unsigned char)combined[2] == 0xa9 && combined[3] == 0 &&
           escape[0] == 'a' && escape[1] == 0;
  }`);
});

test('u8 strings encode ASCII, raw Unicode, UCNs and adjacent narrow strings as UTF-8 bytes', () => {
  run(String.raw`int main(void) {
    const char *ascii = u8"ASCII";
    const char *unicode = u8"café";
    const char *joined = u8"\u00E9" "f";
    return ascii[0] == 'A' && ascii[4] == 'I' && ascii[5] == 0 &&
           (unsigned char)unicode[3] == 0xc3 && (unsigned char)unicode[4] == 0xa9 && unicode[5] == 0 &&
           (unsigned char)joined[0] == 0xc3 && (unsigned char)joined[1] == 0xa9 && joined[2] == 'f' && joined[3] == 0;
  }`);
});

test('multi-character constants use left-to-right LP64 int byte packing', () => {
  run(String.raw`int main(void) {
    return 'ab' == 0x6162 && 'abcde' == 0x62636465 && '\xFF' == -1;
  }`);
});

test('UCNs cannot designate basic characters except dollar, at sign, and grave accent', () => {
  const invalidSpellings = [
    String.raw`\u0000`,
    String.raw`\u0061`,
    String.raw`\u007f`,
    String.raw`\u0080`,
    String.raw`\u009f`,
  ];
  for (const spelling of invalidSpellings) {
    const result = prepare(project(`int main(void) { const char *value = "${spelling}"; return 0; }`));
    assert.equal(result.kind, 'prepare-error', spelling);
    assert.equal(result.diagnostics[0].code, 'INVALID_UNIVERSAL_CHARACTER_NAME');
  }

  const invalidIdentifier = prepare(project(String.raw`int main(void) { int \u0061 = 1; return 0; }`));
  assert.equal(invalidIdentifier.kind, 'prepare-error');
  assert.equal(invalidIdentifier.diagnostics[0].code, 'INVALID_UNIVERSAL_CHARACTER_NAME');

  const invalidCharacter = prepare(project(String.raw`int main(void) { return '\u0061'; }`));
  assert.equal(invalidCharacter.kind, 'prepare-error');
  assert.equal(invalidCharacter.diagnostics[0].code, 'INVALID_UNIVERSAL_CHARACTER_NAME');

  run(String.raw`int main(void) {
    const char *value = "\u0024\u0040\u0060\u00A0";
    return value[0] == 36 && value[1] == 64 && value[2] == 96 &&
           (unsigned char)value[3] == 0xc2 && (unsigned char)value[4] == 0xa0 && value[5] == 0 &&
           '\u0024' == 36 && '\u0040' == 64 && '\u0060' == 96;
  }`);
});

test('invalid UCN diagnostics retain the physical literal location', () => {
  const result = prepare(project(String.raw`int main(void) {
  return "\uD800"[0];
}`));
  assert.equal(result.kind, 'prepare-error');
  assert.deepEqual(result.diagnostics[0], {
    code: 'INVALID_UNIVERSAL_CHARACTER_NAME',
    message: 'Invalid universal character name: «\\uD800».',
    file: 'literals.c',
    line: 2,
    column: 10,
  });
});
