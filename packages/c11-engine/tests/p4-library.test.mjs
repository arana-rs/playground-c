import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, execute, prepare } from '../dist/core/index.js';
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

test('assert follows NDEBUG at each inclusion and provides the static_assert alias', () => {
  const sources = [
    `#include <assert.h>
static int before_ndebug(void) {
    int count = 0;
    assert(++count == 1);
    return count;
}
#define NDEBUG
#include <assert.h>
static_assert(sizeof(int) == 4, "static_assert alias");
int main(void) {
    int count = 0;
    assert(++count == 1);
    return before_ndebug() == 1 && count == 0 ? 0 : 1;
}`,
    `#define NDEBUG
#include <assert.h>
static int while_disabled(void) {
    int count = 0;
    assert(++count == 1);
    return count;
}
#undef NDEBUG
#include <assert.h>
static_assert(sizeof(int) == 4, "static_assert alias");
int main(void) {
    int count = 0;
    assert(++count == 1);
    return while_disabled() == 0 && count == 1 ? 0 : 1;
}`,
  ];
  for (const source of sources) {
    const program = prepareProject(prepare, {
      entry: 'assert-reinclude.c',
      files: [{ name: 'assert-reinclude.c', source }],
    });
    executeTerminated(execute, program, undefined, 0);
  }
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

test('limits.h reports the C-locale MB_LEN_MAX profile value', () => {
  const program = prepareProject(prepare, {
    entry: 'mb-len-max.c',
    files: [{ name: 'mb-len-max.c', source: '#include <limits.h>\nint main(void) { return MB_LEN_MAX == 1 ? 0 : 1; }' }],
  });
  executeTerminated(execute, program, undefined, 0);
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

test('memchr scans unsigned bytes within its count and returns a usable pointer', () => {
  assert.ok(CAPABILITIES.stringFunctions.includes('memchr'));
  const program = prepareProject(prepare, {
    entry: 'memchr.c',
    files: [{
      name: 'memchr.c',
      source: `#include <string.h>
#include <stdint.h>
int main(void) {
    unsigned char bytes[] = { 0x01, 0x80, 0xff, 'A' };
    unsigned char first = 0x42;
    unsigned char *high = memchr(bytes, 0x180, sizeof bytes);
    unsigned char *wrapped = memchr(bytes, 0x1ff, sizeof bytes);
    if (high != &bytes[1] || *high != 0x80) return 1;
    if (wrapped != &bytes[2] || *wrapped != 0xff) return 2;
    if (memchr(bytes, 'z', sizeof bytes) != NULL) return 3;
    if (memchr(bytes, 0x180, 0) != NULL) return 4;
    if (memchr(bytes, 'A', sizeof bytes - 1) != NULL) return 5;
    if (memchr(&first, 0x142, 2) != &first) return 6;
    if (memchr(&first, 0x142, SIZE_MAX) != &first) return 7;
    return 0;
}`,
    }],
  });
  executeTerminated(execute, program, undefined, 0);
});

test('memchr enforces byte bounds and contributes reads to restrict diagnostics', () => {
  const outOfBounds = prepareProject(prepare, {
    entry: 'memchr-bounds.c',
    files: [{
      name: 'memchr-bounds.c',
      source: `#include <string.h>
int main(void) {
    unsigned char bytes[] = { 0x80, 0x81 };
    (void)memchr(bytes, 0x7f, sizeof bytes + 1);
    return 0;
}`,
    }],
  });
  const boundsResult = execute(outOfBounds);
  assert.equal(boundsResult.kind, 'runtime-error', JSON.stringify(boundsResult));
  assert.equal(boundsResult.diagnostics[0].code, 'POINTER_BOUNDS');

  const restrictAlias = prepareProject(prepare, {
    entry: 'memchr-restrict.c',
    files: [{
      name: 'memchr-restrict.c',
      source: `#include <string.h>
static void inspect(const unsigned char * restrict reader, unsigned char *plain) {
    (void)memchr(reader, 0xff, 1);
    *plain = 0;
}
int main(void) {
    unsigned char value = 0xff;
    inspect(&value, &value);
    return 0;
}`,
    }],
  });
  const restrictResult = execute(restrictAlias);
  assert.equal(restrictResult.kind, 'runtime-error', JSON.stringify(restrictResult));
  assert.equal(restrictResult.diagnostics[0].code, 'RESTRICT_ALIAS');
});

test('memchr stops reading at its first match', () => {
  const program = prepareProject(prepare, {
    entry: 'memchr-early-match.c',
    files: [{
      name: 'memchr-early-match.c',
      source: `#include <string.h>
static void inspect(const unsigned char * restrict matched, unsigned char *trailing) {
    (void)memchr(matched, 'A', 2);
    *trailing = 'C';
}
int main(void) {
    unsigned char bytes[2] = { 'A', 'B' };
    inspect(bytes, &bytes[1]);
    return bytes[1] == 'C' ? 0 : 1;
}`,
    }],
  });
  executeTerminated(execute, program, undefined, 0);
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
