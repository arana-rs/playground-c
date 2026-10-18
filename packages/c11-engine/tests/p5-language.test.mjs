import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, createDebugSession, execute, prepare } from '../dist/core/index.js';
import { fixtureSourceFor } from './p4-test-helpers.mjs';

const sourceFor = (name) => fixtureSourceFor('p5', name);
const project = (source, name = 'p5.c') => ({ entry: name, files: [{ name, source }] });
const projectFromFiles = (entry, names, translationUnits = names) => ({
  entry,
  files: names.map((name) => ({ name, source: sourceFor(name) })),
  translationUnits,
});
const compile = (source, name) => {
  const result = prepare(project(source, name));
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
};
const run = (source, expected = 1, name) => {
  const result = execute(compile(source, name));
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected, source);
  return result;
};
const rejects = (source, name = 'p5-invalid.c') => {
  const result = prepare(project(source, name));
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.code));
  assert.equal(result.diagnostics[0].file, name);
  assert.ok(result.diagnostics[0].line > 0);
  assert.ok(result.diagnostics[0].column > 0);
  return result.diagnostics;
};

function pauseBeforeLine(session, targetLine, maxSteps = 2_000) {
  for (let index = 0; index < maxSteps; index += 1) {
    const progress = session.resume();
    if (progress.kind !== 'paused' || progress.location.line === targetLine) return progress;
  }
  assert.fail(`The session did not reach line ${targetLine}.`);
}

test('CAPABILITIES publishes the P6 profile without claiming full C11 or the full library', () => {
  assert.equal(CAPABILITIES.phase, 'P6');
  assert.equal(CAPABILITIES.completeC11, false);
  assert.equal(CAPABILITIES.library, 'partial');
  assert.ok(CAPABILITIES.virtualHeaders.includes('stdalign.h'));
  assert.ok(CAPABILITIES.aggregateMembers.includes('bit-fields'));
  assert.ok(CAPABILITIES.aggregateMembers.includes('flexible-array-members'));
  assert.ok(CAPABILITIES.qualifiers.includes('const'));
  assert.ok(CAPABILITIES.qualifiers.includes('volatile'));
  assert.ok(CAPABILITIES.qualifiers.includes('restrict'));
  assert.ok(CAPABILITIES.genericSelection);
  assert.ok(CAPABILITIES.staticAssertions);
  assert.deepEqual(CAPABILITIES.storageClasses, ['auto', 'extern', 'register', 'static', '_Thread_local', 'typedef']);
  assert.ok(CAPABILITIES.storageDurations.includes('thread-local'));
  assert.deepEqual(CAPABILITIES.linkage, ['external', 'internal', 'no-linkage']);
  assert.equal(CAPABILITIES.blockExternDeclarations, true);
  assert.equal(CAPABILITIES.externalInlineSemantics, 'c11');
  assert.ok(CAPABILITIES.operators.includes('_Alignas'));
  assert.ok(CAPABILITIES.operators.includes('_Alignof'));
  assert.ok(CAPABILITIES.operators.includes('_Static_assert'));
  assert.ok(CAPABILITIES.operators.includes('offsetof'));
  assert.ok(CAPABILITIES.stddefMacros.includes('offsetof'));
  assert.ok(CAPABILITIES.stddefTypes.includes('max_align_t'));
  assert.deepEqual(CAPABILITIES.stdalignMacros, ['alignas', 'alignof', '__alignas_is_defined', '__alignof_is_defined']);
  assert.ok(['fma', 'fmaf', 'fmal'].every((name) => CAPABILITIES.mathFunctions?.includes(name) ?? false));
  assert.match(CAPABILITIES.variableLengthArrays, /dynamic-sizeof/);
  assert.ok(Object.isFrozen(CAPABILITIES));
});

test('P5 accepts the nine implemented families with aliases, conversions and profile layout', async (t) => {
  for (const name of [
    'generic-selection.c',
    'generic-lvalue.c',
    'generic-ice-constant.c',
    'bitfields-layout.c',
    'bitfields-sysv.c',
    'flexible-array-member.c',
    'alignment-stddef.c',
    'typedef-declarators.c',
    'incomplete-declarators.c',
    'declarator-scopes.c',
    'qualifiers-promotions.c',
    'array-parameter-modifiers.c',
    'prototype-default-promotions.c',
    'pointer-uintptr-roundtrip.c',
    'linkage-composite.c',
    'duration-effective-type.c',
    'thread-local.c',
  ]) {
    await t.test(name, () => run(sourceFor(name), 1, name));
  }
});

test('diagnoses bitfield, FAM, qualifier, generic, alignment and typedef constraints', async (t) => {
  const cases = [
    'struct Bad { unsigned int too_wide : 33; }; int main(void) { return 0; }',
    'struct Bad { int named_zero : 0; }; int main(void) { return 0; }',
    'int main(void) { struct Bits { unsigned value : 1; } bits = { 0 }; return (int)&bits.value; }',
    'int main(void) { struct Bits { unsigned value : 1; } bits = { 0 }; return (int)sizeof bits.value; }',
    'struct Bad { int values[]; }; int main(void) { return 0; }',
    'struct Bad { int count; int values[]; int tail; }; int main(void) { return 0; }',
    'union Bad { int values[]; }; int main(void) { return 0; }',
    'int main(void) { int **source = 0; const int **target = source; return target != 0; }',
    'struct Bad { const int value; }; int main(void) { struct Bad left = { 1 }, right = { 2 }; left = right; return 0; }',
    'int main(void) { const int value = 1; value = 2; return value; }',
    'int function(int value); int function(const int value) { value = 2; return value; } int main(void) { return function(1); }',
    'typedef int A[2]; int main(void) { const A values = { 1, 2 }; values[0] = 3; return values[0]; }',
    'int main(void) { return _Generic(1, int: 1, signed int: 2, default: 0); }',
    'int main(void) { return _Generic(1, float: 1); }',
    '_Alignas(2) long double value; int main(void) { return 0; }',
    '_Static_assert(0, "false assertion"); int main(void) { return 0; }',
    'struct Bits { unsigned value : 1; }; int main(void) { struct Bits bits = { 0 }; return __builtin_offsetof(struct Bits, value); }',
    'typedef int Value; typedef long Value; int main(void) { return 0; }',
    'typedef int Array[]; typedef int Array[3]; int main(void) { return 0; }',
    'typedef int Function(); typedef int Function(int); int main(void) { return 0; }',
    'typedef const int Qualified; typedef int Qualified; int main(void) { return 0; }',
    'typedef void Bad[2]; int main(void) { return 0; }',
    'typedef int Bad(void)[2]; int main(void) { return 0; }',
    'typedef int Bad(void)(void); int main(void) { return 0; }',
    'typedef int Bad[2](void); int main(void) { return 0; }',
    'typedef int T; void f(int T, T value); int main(void) { return 0; }',
    'void f(struct Hidden *); struct Hidden { int value; }; void f(struct Hidden *); int main(void) { return 0; }',
    'typedef void VoidType; typedef VoidType Bad[2]; int main(void) { return 0; }',
    'int main(void) { typedef void VoidType; typedef VoidType Bad[2]; return 0; }',
    'int main(void) { typedef void VoidType; VoidType values[2]; return 0; }',
    'int main(void) { return (int)sizeof(void[2]); }',
    'int main(void) { (void[2])0; return 0; }',
    'int main(void) { return (int)sizeof(int(void)[2]); }',
    'struct S; void invalid_array_parameter(struct S value[]); int main(void) { return 0; }',
    'struct S; struct S returns_incomplete(void) { return; } int main(void) { return 0; }',
    'struct S; int takes_incomplete(struct S value) { return 0; } int main(void) { return 0; }',
    'struct S; struct S returns_incomplete(void); int main(void) { returns_incomplete(); return 0; }',
    'struct S; struct S returns_incomplete(void); int main(void) { struct S (*pointer)(void) = returns_incomplete; pointer(); return 0; }',
    'int main(void) { int values[static 3]; return values[0]; }',
    'const int values[const 3]; int main(void) { return values[0]; }',
    'int values[restrict 3]; int main(void) { return values[0]; }',
    'int invalid(const int values[const 3]) { values = values + 1; return 0; } int main(void) { int values[3] = { 1, 2, 3 }; return invalid(values); }',
    'int main(void) { const int value = 1; _Generic(0, int: value, default: value) = 2; return value; }',
    'struct Bits { unsigned value : 1; }; int main(void) { struct Bits bits = { 0 }; return (int)&_Generic(0, int: bits.value, default: bits.value); }',
    'int main(void) { register int value = 1; int *pointer = &_Generic(0, int: value, default: value); return *pointer; }',
    '_Static_assert((int)(1.2 + 0.3), "not an integer constant expression"); int main(void) { return 0; }',
    'struct Bad { unsigned value : (int)(1.2 + 0.3); }; int main(void) { return 0; }',
    '_Alignas((int)(1.2 + 0.3)) int value; int main(void) { return 0; }',
    'int main(void) { _Alignas(0) register int value = 1; return value; }',
  ];
  for (const [index, source] of cases.entries()) {
    await t.test(`constraint ${index + 1}`, () => rejects(source));
  }
});

test('preserves the P6 rejections for atomics, complex and the threads library', async (t) => {
  const cases = [
    '#include <stdatomic.h>\nint main(void) { atomic_int value = 0; return atomic_load(&value); }',
    '#include <complex.h>\nint main(void) { double complex value = 1.0 + 2.0 * I; return creal(value) == 1.0; }',
    '#include <threads.h>\nint main(void) { return 0; }',
  ];
  for (const [index, source] of cases.entries()) {
    await t.test(`P6 ${index + 1}`, () => rejects(source));
  }
});

test('initializes const character arrays from strings with explicit and inferred bounds', () => {
  run(`
    const char file_explicit[3] = "abc";
    const char file_inferred[] = "ab";
    const char file_braced_inferred[] = { "abc" };
    char file_plain_braced_inferred[] = { "xy" };
    const char file_utf8_braced_inferred[] = { "\\u00E9" };

    int main(void) {
      const char block_explicit[3] = "abc";
      const char block_braced[3] = { "abc" };
      const char block_inferred[] = "abc";
      const char block_braced_inferred[] = { "abc" };
      char block_plain_braced_inferred[] = { "xy" };
      return sizeof file_explicit == 3 && sizeof file_inferred == 3 &&
        sizeof file_braced_inferred == 4 && sizeof file_plain_braced_inferred == 3 &&
        sizeof file_utf8_braced_inferred == 3 &&
        sizeof block_explicit == 3 && sizeof block_inferred == 4 &&
        sizeof block_braced_inferred == 4 && sizeof block_plain_braced_inferred == 3 &&
        file_explicit[0] == 'a' && file_explicit[2] == 'c' &&
        file_inferred[2] == '\\0' && file_braced_inferred[3] == '\\0' &&
        file_plain_braced_inferred[2] == '\\0' && block_explicit[2] == 'c' &&
        (unsigned char)file_utf8_braced_inferred[0] == 0xc3 &&
        (unsigned char)file_utf8_braced_inferred[1] == 0xa9 && file_utf8_braced_inferred[2] == '\\0' &&
        block_braced[2] == 'c' && block_inferred[3] == '\\0' &&
        block_braced_inferred[3] == '\\0' && block_plain_braced_inferred[2] == '\\0';
    }
  `, 1);
  rejects('int main(void) { const char text[] = "abc"; text[0] = \'x\'; return 0; }');
});

test('a cast removes the pointer qualifier while respecting whether the original object is const', () => {
  run('int main(void) { int value = 1; const int *view = &value; *(int *)view = 7; return value == 7; }', 1);
  const prepared = compile('int main(void) { const int value = 1; const int *view = &value; *(int *)view = 7; return value; }');
  const result = execute(prepared);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'CONST_OBJECT_MODIFICATION');
});

test('external inline requires one external definition and respects its C11 constraints', () => {
  const files = [
    { name: 'main.c', source: 'int value(void); int main(void) { return value() == 1; }' },
    { name: 'first.c', source: 'int value(void) { return 1; }' },
    { name: 'second.c', source: 'int value(void) { return 1; }' },
  ];
  const duplicate = prepare({ entry: 'main.c', files, translationUnits: ['main.c', 'first.c', 'second.c'] });
  assert.equal(duplicate.kind, 'prepare-error', JSON.stringify(duplicate));
  assert.ok(duplicate.diagnostics.some(({ code }) => code));

  const externInline = compile(sourceFor('inline/extern-inline.c'), 'extern-inline.c');
  assert.equal(execute(externInline).mainReturn, 1);
  for (const [entry, names] of [
    ['inline/static-const/main.c', ['inline/static-const/main.c', 'inline/static-const/inline.c', 'inline/static-const/external.c']],
    ['inline/extern-inline-static.c', ['inline/extern-inline-static.c']],
    ['inline/static-inline-static.c', ['inline/static-inline-static.c']],
  ]) {
    const prepared = prepare(projectFromFiles(entry, names));
    assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
    assert.equal(execute(prepared.program).mainReturn, 1);
  }
  for (const directory of ['invalid-static-local', 'invalid-static-array', 'invalid-static-mixed-aggregate', 'invalid-internal-reference']) {
    const entry = `inline/${directory}/main.c`;
    const names = [entry, `inline/${directory}/inline.c`, `inline/${directory}/external.c`];
    const invalidInline = prepare(projectFromFiles(entry, names));
    assert.equal(invalidInline.kind, 'prepare-error', JSON.stringify(invalidInline));
    assert.ok(invalidInline.diagnostics.some(({ code }) => code === 'TYPE_ERROR'));
  }
  rejects('inline int only_inline(void) { return 3; } int main(void) { return only_inline(); }');
  rejects('int old_style(); int old_style(float); int main(void) { return 0; }');

  const missingExternalDefinition = prepare({
    entry: 'main.c',
    translationUnits: ['main.c', 'inline.c'],
    files: [
      { name: 'main.c', source: 'int only_inline(void); int main(void) { return only_inline(); }' },
      { name: 'inline.c', source: 'inline int only_inline(void) { return 3; }' },
    ],
  });
  assert.equal(missingExternalDefinition.kind, 'prepare-error', JSON.stringify(missingExternalDefinition));
  assert.ok(missingExternalDefinition.diagnostics.some(({ code }) => code === 'UNDEFINED_FUNCTION'));

  rejects('inline int invalid(void) { static int counter; return ++counter; } int main(void) { return invalid(); }');
  rejects('static int internal_value; inline int invalid(void) { return internal_value; } int main(void) { return invalid(); }');
});

test('links block-scope extern and completes an external array across translation units', () => {
  for (const [entry, names] of [
    ['block-extern/main.c', ['block-extern/main.c', 'block-extern/definition.c']],
    ['linkage-array/main.c', ['linkage-array/main.c', 'linkage-array/definition.c']],
  ]) {
    const prepared = prepare(projectFromFiles(entry, names));
    assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
    const result = execute(prepared.program);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 1);
  }
});

test('requires the _Thread_local qualifier on every external declaration of an object', () => {
  const validFiles = ['thread-linkage/main.c', 'thread-linkage/definition.c'];
  const valid = prepare(projectFromFiles(validFiles[0], validFiles));
  assert.equal(valid.kind, 'prepared', JSON.stringify(valid));
  const result = execute(valid.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 1);

  const invalidFiles = ['thread-linkage-invalid/main.c', 'thread-linkage-invalid/definition.c'];
  const invalid = prepare(projectFromFiles(invalidFiles[0], invalidFiles));
  assert.equal(invalid.kind, 'prepare-error', JSON.stringify(invalid));
  assert.ok(invalid.diagnostics.some(({ code }) => code === 'CONFLICTING_TYPES'));
});

test('debug DTOs serialize bitfields, heap FAMs and TLS durations without internal types', () => {
  const source = sourceFor('debug-layout.c');
  const prepared = prepare(project(source, 'debug-layout.c'));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const session = createDebugSession(prepared.program);
  const initialEvents = session.drainEvents();
  assert.ok(initialEvents.some((event) => event.kind === 'object-create' && event.name === 'thread_flags' && event.duration === 'thread-local'));
  assert.deepEqual(structuredClone(initialEvents), initialEvents);

  const finalLine = source.split('\n').findIndex((line) => line.includes('return flags.ready')) + 1;
  assert.equal(pauseBeforeLine(session, finalLine).kind, 'paused');
  const staticObjects = session.inspectStaticObjects();
  const arrays = session.inspectArrays().arrays;
  const pointers = session.inspectPointers();
  const scalars = session.inspectScalars();
  const aggregates = session.inspectAggregates().aggregates;
  assert.ok(staticObjects.some((object) => object.name === 'thread_scalar' && object.duration === 'thread-local'));
  assert.equal(scalars.find((scalar) => scalar.name === 'immutable')?.type, 'const int');
  assert.equal(scalars.find((scalar) => scalar.name === 'observed')?.type, 'volatile int');
  assert.ok(arrays.some((array) => array.name === 'thread_array' && array.duration === 'thread-local' && array.region === 'static'));
  assert.ok(pointers.some((pointer) => pointer.name === 'thread_pointer' && pointer.duration === 'thread-local' && pointer.region === 'static'));
  const flags = aggregates.find((aggregate) => aggregate.name === 'flags');
  assert.ok(flags);
  const namedBits = flags.members.filter((member) => member.bitWidth !== undefined);
  assert.deepEqual(namedBits.map(({ bitWidth, bitOffset, storageUnitSize, offset, size }) => [bitWidth, bitOffset, storageUnitSize, offset, size]), [
    [1, 0, 4, 0, 4], [3, 1, 4, 0, 4], [2, 0, 4, 4, 4],
  ]);
  assert.equal(flags.members.some((member) => member.name === ''), false, 'the zero-width unnamed separator is not published');
  const packet = aggregates.find((aggregate) => aggregate.type.includes('Packet') && aggregate.duration === 'heap');
  assert.ok(packet);
  assert.equal(packet.region, 'heap');
  const values = packet.members.find((member) => member.name === 'values');
  assert.ok(values?.flexibleArray);
  assert.deepEqual(
    [values.flexibleArray.elementSize, values.flexibleArray.capacityBytes, values.flexibleArray.length],
    [4, 12, 3],
  );
  assert.equal(packet.members.find((member) => member.name === 'count')?.displayValue, '3');
  assert.equal(values.flexibleArray.status, 'available');
  assert.deepEqual(values.flexibleArray.elements.map((element) => element.displayValue), ['2', '3', '5']);
  assert.equal(values.flexibleArray.omittedElements, 0);
  assert.deepEqual(values.flexibleArray.elements.map(({ address, index }) => [index, BigInt(address)]), [
    [0, BigInt(packet.address) + BigInt(values.offset)],
    [1, BigInt(packet.address) + BigInt(values.offset) + 4n],
    [2, BigInt(packet.address) + BigInt(values.offset) + 8n],
  ]);
  for (const value of [staticObjects, arrays, pointers, scalars, aggregates]) assert.deepEqual(structuredClone(value), value);
});

test('FAM snapshots limit cells with the same bound as arrays and count the remainder', () => {
  const source = sourceFor('debug-layout.c');
  const prepared = prepare(project(source, 'debug-layout.c'));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const session = createDebugSession(prepared.program, undefined, { maxElementsPerArray: 2 });
  const finalLine = source.split('\n').findIndex((line) => line.includes('return flags.ready')) + 1;
  assert.equal(pauseBeforeLine(session, finalLine).kind, 'paused');
  const packet = session.inspectAggregates().aggregates.find((aggregate) => aggregate.type.includes('Packet') && aggregate.duration === 'heap');
  const values = packet?.members.find((member) => member.name === 'values')?.flexibleArray;
  assert.ok(values);
  assert.equal(values.status, 'too-many-elements');
  assert.deepEqual(values.elements.map((element) => element.displayValue), ['2', '3']);
  assert.equal(values.omittedElements, 1);
});
