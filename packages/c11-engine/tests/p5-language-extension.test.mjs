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

function restrictFailure(source) {
  const name = 'language-extension-restrict-invalid.c';
  const prepared = prepare({ entry: name, files: [{ name, source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'RESTRICT_ALIAS');
}

test('declaradores aceptan storage, function specifiers y qualifiers intercalados', () => {
  run('language-extension-specifiers.c');
  rejects('int static static duplicate; int main(void) { return 0; }');
  rejects('static extern int incompatible; int main(void) { return 0; }');
});

test('?: combina qualifiers inmediatos del puntero y conserva el caso object/void', () => {
  run('language-extension-conditional-pointers.c');
  rejects('int main(void) { int *integer_pointer = 0; float *float_pointer = 0; return (1 ? integer_pointer : float_pointer) != 0; }');
  rejects('int main(void) { int **integer_pointer = 0; const int **qualified_pointer = 0; return (1 ? integer_pointer : qualified_pointer) != 0; }');
});

test('una declaración sin prototipo compone con la declaración de función sin parámetros', () => {
  run('language-extension-legacy-prototype.c');
  rejects('int legacy(); int legacy(float); int main(void) { return 0; }');
});

test('composición L07/L11 cubre orden de especificadores, shadowing, arrays y default promotions', () => {
  run('language-extension-declarations.c');
  rejects('extern int incompatible_array[]; extern int incompatible_array[3]; int incompatible_array[4]; int main(void) { return 0; }');
  rejects('typedef int Value; int main(void) { int Value; typedef long Value; return 0; }');
});

test('el linker comparte compatibilidad y tipos compuestos entre unidades', () => {
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

test('_Generic en ICE usa el tipo compuesto de ?: para punteros cualificados', () => {
  run('language-extension-conditional-inference.c');
});

test('restrict perfila alias reales y permite cadenas, lecturas y subobjetos disjuntos', () => {
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
