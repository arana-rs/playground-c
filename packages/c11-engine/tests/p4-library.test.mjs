import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import {
  decodeBytes,
  executeTerminated,
  fixtureProject,
  prepareProject,
} from './p4-test-helpers.mjs';

test('stdio formatting handles printf, fprintf, snprintf and standard format macros', () => {
  const formatted = prepareProject(prepare, fixtureProject('.', 'stdio-format.c'));
  executeTerminated(execute, formatted);

  const output = prepareProject(prepare, fixtureProject('.', 'stdio-output.c'));
  const result = executeTerminated(execute, output, undefined, 0);
  assert.equal(decodeBytes(result.stdout), 'value=42\n');
  assert.equal(decodeBytes(result.stderr), 'done:ok');
  const repeated = executeTerminated(execute, output, undefined, 0);
  assert.equal(decodeBytes(repeated.stdout), 'value=42\n');
  assert.equal(decodeBytes(repeated.stderr), 'done:ok');
});

test('stdio reads and writes binary files through a fresh virtual filesystem', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'stdio-files.c'));
  const options = { io: { files: [{ name: 'input.bin', data: new Uint8Array([65, 0, 66]) }] } };
  executeTerminated(execute, program, options);
  executeTerminated(execute, program, options);
});

test('stdin, EOF, ungetc, seek and stream error indicators follow C stream rules', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'stdio-input.c'));
  executeTerminated(execute, program, { io: { stdin: 'hello\nX' } });
});

test('assert is active by default and disabled when NDEBUG is defined before inclusion', () => {
  const enabled = prepareProject(prepare, fixtureProject('.', 'assert-enabled.c'));
  executeTerminated(execute, enabled, undefined, 0);

  const disabled = prepareProject(prepare, fixtureProject('.', 'assert-disabled.c'));
  executeTerminated(execute, disabled, undefined, 42);
});

test('a failed assertion terminates with a runtime diagnostic and no success status', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'assert-failure.c'));
  const result = execute(program);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0].file, 'assert-failure.c');
  assert.equal('exitCode' in result, false);
});

test('C locale character classification and errno conversion behavior are deterministic', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'ctype-errno.c'));
  executeTerminated(execute, program);
  executeTerminated(execute, program);
});

test('stdint limits and integer constant macros preserve LP64 values and bool normalization', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'headers.c'));
  executeTerminated(execute, program);
});

test('inttypes format and scan macros and strtoimax preserve 64-bit integer values', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'inttypes.c'));
  executeTerminated(execute, program);
});

test('float and double subnormal classification preserves TRUE_MIN without volatile storage', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'float-classification.c'));
  executeTerminated(execute, program, undefined, 0);
});

test('stdio %p output round-trips object and null pointers through sscanf', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'pointer-format.c'));
  executeTerminated(execute, program, undefined, 0);
});

test('stdio formats narrow and hexadecimal values and preserves binary80 long doubles', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'stdio-format-hex-long-double.c'));
  const result = executeTerminated(execute, program, undefined, 0);
  assert.equal(decodeBytes(result.stdout), '');
});

test('stdio rejects wide character and string conversions without falling back to narrow', () => {
  const sources = [
    ['printf', 'int main(void) { printf("%lc", 65); return 0; }'],
    ['printf', 'int main(void) { char text[8]; snprintf(text, sizeof text, "%ls", "x"); return 0; }'],
    ['scanf', 'int main(void) { int value; scanf("%lc", &value); return 0; }'],
    ['scanf', 'int main(void) { char text[8]; sscanf("x", "%ls", text); return 0; }'],
    ['scanf', 'int main(void) { scanf("%*lc"); return 0; }'],
    ['scanf', 'int main(void) { sscanf("x", "%*ls"); return 0; }'],
    ['scanf', 'int main(void) { sscanf("x", "%*l[a]"); return 0; }'],
    ['scanf', 'int main(void) { char text[8]; sscanf("x", "%l[a]", text); return 0; }'],
  ];
  for (const [conversion, source] of sources) {
    const program = prepareProject(prepare, {
      entry: 'wide-format.c',
      files: [{ name: 'wide-format.c', source: `#include <stdio.h>\n${source}` }],
    });
    const result = execute(program);
    assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
    assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_FEATURE');
    assert.match(result.diagnostics[0].message, new RegExp(`^Wide ${conversion} conversion`));
  }
});

test('sscanf numeric conversions stop at separators and preserve scanf token prefixes', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'sscanf-numeric-boundaries.c'));
  executeTerminated(execute, program, undefined, 0);
});

test('stdarg traverses default promotions and va_copy keeps an independent cursor', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'varargs.c'));
  executeTerminated(execute, program, undefined, 1);
});

test('string and byte routines include overlapping memmove and independent strtok state', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'strings.c'));
  executeTerminated(execute, program);
});

test('virtual output observes the shared I/O byte budget and retains partial bytes', () => {
  const project = {
    entry: 'budget.c',
    files: [{ name: 'budget.c', source: '#include <stdio.h>\nint main(void) { printf("hello"); return 0; }' }],
  };
  const program = prepareProject(prepare, project);
  const result = execute(program, { limits: { maxIOBytes: 4 } });
  assert.equal(result.kind, 'limit', JSON.stringify(result));
  assert.equal(result.resource, 'maxIOBytes');
  assert.ok(result.stdout instanceof Uint8Array);
  assert.ok(result.stdout.length <= 4);
});
