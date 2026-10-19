import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor } from './p4-test-helpers.mjs';

const fixture = (name) => {
  const source = fixtureSourceFor('p5', name);
  return { entry: name, files: [{ name, source }] };
};

function run(name, expected = 1) {
  const prepared = prepare(fixture(name));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected);
}

function rejects(source) {
  const prepared = prepare({ entry: 'language-extension-invalid.c', files: [{ name: 'language-extension-invalid.c', source }] });
  assert.equal(prepared.kind, 'prepare-error', JSON.stringify(prepared));
  assert.ok(prepared.diagnostics.length > 0);
  assert.ok(prepared.diagnostics[0].code);
}

function restrictDiagnostic(source, expectedCode = 'RESTRICT_ALIAS') {
  const name = 'language-extension-restrict-invalid.c';
  const prepared = prepare({ entry: name, files: [{ name, source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, expectedCode);
}

function restrictFailure(source) {
  restrictDiagnostic(source, 'RESTRICT_ALIAS');
}

function restrictRun(source, expected = 1) {
  const name = 'language-extension-restrict-valid.c';
  const prepared = prepare({ entry: name, files: [{ name, source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected, JSON.stringify(result));
}

test('declarators accept interleaved storage classes, function specifiers and qualifiers', () => {
  run('language-extension-specifiers.c');
  rejects('int static static duplicate; int main(void) { return 0; }');
  rejects('static extern int incompatible; int main(void) { return 0; }');
});

test('?: combines immediate pointer qualifiers and preserves the object/void case', () => {
  run('language-extension-conditional-pointers.c');
  rejects('int main(void) { int *integer_pointer = 0; float *float_pointer = 0; return (1 ? integer_pointer : float_pointer) != 0; }');
  rejects('int main(void) { int **integer_pointer = 0; const int **qualified_pointer = 0; return (1 ? integer_pointer : qualified_pointer) != 0; }');
});

test('a no-prototype declaration composes with a function declaration without parameters', () => {
  run('language-extension-legacy-prototype.c');
  rejects('int legacy(); int legacy(float); int main(void) { return 0; }');
});

test('L07/L11 composition covers specifier order, shadowing, arrays and default promotions', () => {
  run('language-extension-declarations.c');
  rejects('extern int incompatible_array[]; extern int incompatible_array[3]; int incompatible_array[4]; int main(void) { return 0; }');
  rejects('typedef int Value; int main(void) { int Value; typedef long Value; return 0; }');
});

test('the linker shares compatibility and composite types across translation units', () => {
  const entry = 'language-extension-composite/main.c';
  const names = [entry, 'language-extension-composite/definition.c'];
  const valid = prepare({
    entry,
    files: names.map((name) => ({ name, source: fixtureSourceFor('p5', name) })),
    translationUnits: names,
  });
  assert.equal(valid.kind, 'prepared', JSON.stringify(valid));
  const linked = execute(valid.program);
  assert.equal(linked.kind, 'terminated', JSON.stringify(linked));
  assert.equal(linked.mainReturn, 1);
  const reversed = prepare({
    entry,
    files: names.map((name) => ({ name, source: fixtureSourceFor('p5', name) })),
    translationUnits: [...names].reverse(),
  });
  assert.equal(reversed.kind, 'prepared', JSON.stringify(reversed));
  const reversedResult = execute(reversed.program);
  assert.equal(reversedResult.kind, 'terminated', JSON.stringify(reversedResult));
  assert.equal(reversedResult.mainReturn, 1);

  const invalidEntry = 'language-extension-composite-invalid/main.c';
  const invalidNames = [invalidEntry, 'language-extension-composite-invalid/definition.c'];
  const invalid = prepare({
    entry: invalidEntry,
    files: invalidNames.map((name) => ({ name, source: fixtureSourceFor('p5', name) })),
    translationUnits: invalidNames,
  });
  assert.equal(invalid.kind, 'prepare-error', JSON.stringify(invalid));
  assert.ok(invalid.diagnostics.some(({ code }) => code === 'CONFLICTING_TYPES'));
});

test('_Generic in an ICE uses the composite type of ?: for qualified pointers', () => {
  run('language-extension-conditional-inference.c');
});

test('_Generic supplies integer constant array bounds at file and block scope', () => {
  const entry = 'language-extension-generic-array-bounds.c';
  const source = `
int global_values[_Generic(0, int: 3, default: 1)];
_Static_assert(sizeof(int[_Generic(0, int: 3, default: 1)]) == 3 * sizeof(int), "global array bound");

int main(void) {
  int local_values[_Generic(0, int: 3, default: 1)];
  _Static_assert(sizeof(int[_Generic(0, int: 3, default: 1)]) == 3 * sizeof(int), "local array bound");
  return sizeof global_values / sizeof global_values[0] == 3 &&
      sizeof local_values / sizeof local_values[0] == 3 ? 0 : 1;
}
`;
  const prepared = prepare({ entry, files: [{ name: entry, source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

test('restrict tracks real aliases and permits disjoint chains, reads and subobjects', () => {
  run('language-extension-restrict.c');
  restrictFailure(`static void update(int * restrict left, int * restrict right) {
    *left = 1;
    *right = 2;
  }
  int main(void) { int value = 0; update(&value, &value); return value; }`);
  restrictFailure(`static void update(int * restrict restricted, int *plain) {
    *restricted = 1;
    *plain += 1;
  }
  int main(void) { int value = 0; update(&value, &value); return value; }`);
  restrictFailure(`static void inspect(int * restrict write, const int * restrict read) {
    *write = 1;
    (void)*read;
  }
  int main(void) { int value = 0; inspect(&value, &value); return value; }`);
});

test('restrict observes character and library writes to overlapping bytes', () => {
  restrictFailure(`static void update(int * restrict pointer, int *plain) {
    *pointer = 1;
    ((unsigned char *)plain)[1] = 2;
  }
  int main(void) { int value = 0; update(&value, &value); return value; }`);
  restrictFailure(`#include <string.h>
  static void update(int * restrict pointer, int *plain) {
    *pointer = 1;
    memset(plain, 0, sizeof *plain);
  }
  int main(void) { int value = 0; update(&value, &value); return value; }`);
  restrictFailure(`#include <string.h>
  static void copy(int * restrict destination, int * restrict source) {
    memmove(destination, source, sizeof *destination);
  }
  int main(void) { int value = 0; copy(&value, &value); return value; }`);
});

test('restrict limits byte and string-library observations to accessed characters', () => {
  restrictRun(`static void update(char * restrict pointer, char *plain) {
    pointer[0] = 'a';
    plain[1] = 'b';
  }
  int main(void) { char text[3] = { 0, 0, 0 }; update(text, text); return text[0] == 'a' && text[1] == 'b'; }`);
  restrictRun(`#include <string.h>
  static void inspect(const char * restrict pointer, const char *plain, char *output) {
    (void)strncmp(pointer, plain, 1);
    output[1] = 'x';
  }
  int main(void) { char text[4] = "abc"; inspect(text, text, text); return text[1] == 'x'; }`);
  restrictRun(`#include <string.h>
  static void inspect(const char * restrict pointer, char *plain) {
    (void)strspn(pointer, "a");
    plain[2] = 'x';
  }
  int main(void) { char text[4] = "abc"; inspect(text, text); return text[2] == 'x'; }`);
  restrictRun(`#include <string.h>
  static void copy(const char * restrict source, char *plain) {
    strncpy(plain + 1, source, 1);
  }
  int main(void) { char text[4] = "abc"; copy(text, text); return text[1] == 'a'; }`);
});

test('restrict preserves integer pointer round-trips and marks library-lost provenance explicitly', () => {
  restrictRun(`#include <stdint.h>
  #include <string.h>
  static void update(int * restrict pointer) {
    uintptr_t bits = (uintptr_t)pointer;
    bits += 0;
    bits *= 1;
    uintptr_t copy = 0;
    memcpy(&copy, &bits, sizeof bits);
    int *round_trip = (int *)copy;
    *pointer = 1;
    *round_trip = 2;
  }
  int main(void) { int value = 0; update(&value); return value == 2; }`);
  restrictDiagnostic(`#include <stdint.h>
  #include <stdio.h>
  #include <stdlib.h>
  static void update(int * restrict pointer) {
    char text[32];
    snprintf(text, sizeof text, "%lu", (unsigned long)(uintptr_t)pointer);
    uintptr_t address = (uintptr_t)strtoull(text, 0, 10);
    int *unknown = (int *)address;
    *pointer = 1;
    *unknown = 2;
  }
  int main(void) { int value = 0; update(&value); return value; }`, 'RESTRICT_PROVENANCE_UNKNOWN');
  restrictRun(`#include <stdint.h>
  #include <stdio.h>
  #include <stdlib.h>
  static int inspect(int * restrict pointer) {
    char text[32];
    snprintf(text, sizeof text, "%lu", (unsigned long)(uintptr_t)pointer);
    uintptr_t address = (uintptr_t)strtoull(text, 0, 10);
    int *uncertain = (int *)address;
    return *pointer + *uncertain;
  }
  int main(void) { int value = 2; return inspect(&value) == 4; }`);
});

test('restrict distinguishes adjacent bit-fields and overlapping byte ranges', () => {
  restrictRun(`struct Bits { unsigned left : 4; unsigned right : 4; };
  static void update(struct Bits * restrict pointer, struct Bits *plain) {
    pointer->left = 1;
    plain->right = 2;
  }
  int main(void) { struct Bits value = { 0, 0 }; update(&value, &value); return value.left == 1 && value.right == 2; }`);
});

test('restrict permits overlapping memmove through one pointer association', () => {
  restrictRun(`#include <string.h>
  static void shift(int * restrict pointer) {
    memmove(pointer + 1, pointer, 3 * sizeof *pointer);
  }
  int main(void) { int values[4] = { 1, 2, 3, 4 }; shift(values); return values[1] == 1 && values[3] == 3; }`);
});

test('restrict observes library reads and writes of errno', () => {
  restrictFailure(`#include <errno.h>
  #include <stdio.h>
  static void inspect(int * restrict pointer) {
    *pointer = 1;
    perror(0);
  }
  int main(void) { inspect(&errno); return 0; }`);
  restrictFailure(`#include <errno.h>
  #include <math.h>
  static void update(int * restrict pointer) {
    *pointer = 0;
    (void)acos(2.0);
  }
  int main(void) { update(&errno); return 0; }`);
});
