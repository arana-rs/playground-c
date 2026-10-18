import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const project = (source) => ({ entry: 'enum-types.c', files: [{ name: 'enum-types.c', source }] });

function run(source, expected = 0) {
  const prepared = prepare(project(source));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected, source);
  return result;
}

function rejects(source, code = 'TYPE_ERROR') {
  const prepared = prepare(project(source));
  assert.equal(prepared.kind, 'prepare-error', JSON.stringify(prepared));
  assert.ok(prepared.diagnostics.some((diagnostic) => diagnostic.code === code), JSON.stringify(prepared.diagnostics));
}

test('enum keeps an identity distinct from other enums, promotes to int and uses the LP64 int layout', () => {
  const result = run(`#include <stdio.h>
    enum Mode { MODE = 7 };
    enum Other { OTHER = 8 };
    _Static_assert(_Generic(MODE, int: 1, default: 0), "enumerators have type int");
    int main(void) {
      enum Mode value = MODE;
      enum Mode *pointer = &value;
      if (_Generic(value, enum Mode: 1, default: 0) != 1) return 1;
      if (_Generic(value, int: 1, default: 0) != 1) return 2;
      if (_Generic(value, enum Mode: 1, enum Other: 2, default: 3) != 1) return 3;
      if (sizeof value != sizeof(int) || _Alignof(enum Mode) != _Alignof(int)) return 4;
      if (sizeof pointer != sizeof(void *) || pointer + 1 != &value + 1) return 5;
      if (sscanf("8", "%d", &value) != 1 || value != 8) return 6;
      if (value + 2 != 10) return 7;
      printf("%d %d\\n", value, value + 2);
      return 0;
    }`);
  assert.equal(new TextDecoder().decode(result.stdout), '8 10\n');
});

test('same-tag enums in another scope and distinct anonymous enums keep their own identities', () => {
  rejects(`enum Shade { OUTER_SHADE };
    int main(void) {
      enum Shade *outer = 0;
      {
        enum Shade { INNER_SHADE };
        enum Shade *inner = 0;
        outer = inner;
      }
      return 0;
    }`);
  rejects(`typedef enum { FIRST_VALUE } FirstEnum;
    typedef enum { SECOND_VALUE } SecondEnum;
    int main(void) { FirstEnum *first = 0; SecondEnum *second = 0; first = second; return 0; }`);
  rejects(`typedef int Token;
    enum Choice { Token = 1 };
    int main(void) { return 0; }`, 'REDECLARATION');
  run(`typedef int Token;
    int main(void) { enum Choice { Token = 2 }; return Token - 2; }`);
});

test('pointers and function declarations with distinct enums are incompatible', () => {
  rejects(`enum A { A_VALUE };
    enum B { B_VALUE };
    int main(void) { enum A *left = 0; enum B *right = left; return right != 0; }`);
  rejects(`enum A { A_VALUE };
    enum B { B_VALUE };
    int convert(enum A);
    int convert(enum B);
    int main(void) { return 0; }`, 'CONFLICTING_TYPES');
  rejects(`enum E { E_VALUE };
    int main(void) {
      enum E value = E_VALUE;
      return _Generic(value, enum E: 1, int: 2);
    }`);
});

test('the linker canonicalizes compatible tagged enums across translation units', () => {
  const entry = 'enum-project/main.c';
  const definition = 'enum-project/definition.c';
  const valid = prepare({
    entry,
    translationUnits: [entry, definition],
    files: [
      { name: entry, source: 'enum State { OFF = 2, ON = 5 }; int advance(enum State *); int main(void) { enum State value = ON; return advance(&value) - 6; }' },
      { name: definition, source: 'enum State { OFF = 2, ON = 5 }; int advance(enum State *value) { return *value + 1; }' },
    ],
  });
  assert.equal(valid.kind, 'prepared', JSON.stringify(valid));
  const result = execute(valid.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);

  const invalid = prepare({
    entry,
    translationUnits: [entry, definition],
    files: [
      { name: entry, source: 'enum State { OFF = 2, ON = 5 }; int advance(enum State *); int main(void) { enum State value = ON; return advance(&value); }' },
      { name: definition, source: 'enum State { OFF = 2, ON = 6 }; int advance(enum State *value) { return *value; }' },
    ],
  });
  assert.equal(invalid.kind, 'prepare-error', JSON.stringify(invalid));
  assert.ok(invalid.diagnostics.some(({ code }) => code === 'CONFLICTING_TYPES'));
});

test('anonymous enums with matching members are compatible only across distinct translation units', () => {
  const entry = 'anonymous-enums/main.c';
  const definition = 'anonymous-enums/definition.c';
  const prepared = prepare({
    entry,
    translationUnits: [entry, definition],
    files: [
      { name: entry, source: 'typedef enum { MARK = 4 } Marker; int accept(Marker); int main(void) { return accept(MARK) - 4; }' },
      { name: definition, source: 'typedef enum { MARK = 4 } Marker; int accept(Marker value) { return value; }' },
    ],
  });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
});
