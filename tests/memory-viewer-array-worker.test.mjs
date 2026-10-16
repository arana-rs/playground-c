import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';
import {
  cloneMemoryViewerArraySnapshot,
  filterMemoryViewerStaticScalars,
  findMemoryViewerChangedArrayElementKeys,
  sameMemoryViewerArraySnapshot,
} from '../src/memory/arraySnapshots.ts';

const arrayFixtureSource = readFileSync(new URL('./fixtures/memory-viewer-arrays.c', import.meta.url), 'utf8');

function arraySnapshot(rootId, name, values, { initialized = values.map(() => true), region = 'stack' } = {}) {
  const length = values.length;
  return {
    rootId,
    name,
    origin: 'variable',
    duration: region === 'stack' ? 'automatic' : 'static',
    region,
    frameId: region === 'stack' ? 1 : null,
    scopeId: region === 'stack' ? 2 : null,
    type: `int[${length}]`,
    elementType: 'int',
    address: `0x${(0x20000 + rootId * 0x100).toString(16)}`,
    size: length * 4,
    length,
    readOnly: false,
    status: 'available',
    elements: values.map((displayValue, index) => ({
      key: `${rootId}:${index}`,
      index,
      address: `0x${(0x20000 + rootId * 0x100 + index * 4).toString(16)}`,
      type: 'int',
      initialized: initialized[index],
      displayValue,
      valueTruncated: false,
    })),
  };
}

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  messages = [];
  terminated = false;

  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}

function paused(line) {
  return {
    kind: 'paused',
    location: { file: 'main.c', line, column: 1 },
    metrics: {
      prepareMs: 0,
      executeMs: 0,
      sourceChars: 0,
      tokenCount: 0,
      preprocessSteps: 0,
      instructionCount: 0,
      peakMemoryBytes: 0,
    },
  };
}

function setupController() {
  const workers = [];
  const controller = new MemoryViewerController('int main(void) { return 0; }', {
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  controller.start();
  return { controller, workers };
}

test('el Worker transporta arrays por elemento y llega a exit 0 aunque haya placeholders locales', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-array-worker-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 241, fileName: 'main.c', source: arrayFixtureSource,
    } });
    assert.equal(responses[0].type, 'debug-ready');
    assert.ok(Array.isArray(responses[0].arrays));

    let terminal;
    for (let requestId = 1; requestId <= 100; requestId += 1) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 241, requestId } });
      const response = responses.at(-1);
      assert.equal(response.type, 'debug-progress');
      assert.ok(Array.isArray(response.arrays));
      if (response.progress.kind !== 'paused') {
        terminal = response;
        break;
      }
    }

    assert.ok(terminal, 'la sesión alcanza un estado terminal');
    assert.equal(terminal.progress.kind, 'terminated', JSON.stringify(terminal.progress));
    assert.equal(terminal.progress.mainReturn, 0);
    assert.equal(terminal.progress.exitCode, 0);
    assert.ok(responses.every(response => response.omittedArrayObjects === 0));
    assert.ok(responses.every(response => response.staticObjects.every(object => object.origin !== 'string-literal')));

    const observations = responses.flatMap(response => response.arrays.map(array => ({ step: response, array })));
    const latestByName = name => observations.filter(({ array }) => array.name === name).at(-1)?.array;
    const findValues = name => observations
      .filter(({ array }) => array.name === name)
      .map(({ array }) => array.elements.map(element => element.displayValue));
    const compactUnique = snapshots => snapshots.filter((values, index) =>
      index === 0 || JSON.stringify(values) !== JSON.stringify(snapshots[index - 1]));

    const aSnapshots = observations.filter(({ array }) => array.name === 'a').map(({ array }) => array);
    assert.ok(aSnapshots.length > 4, '`a` conserva snapshots a través de las visitas de línea');
    assert.ok(aSnapshots.every(array => array.status === 'available' && array.length === 4));
    assert.deepEqual(
      compactUnique(findValues('a').map(values => values.join(','))),
      ['10,20,0,0', '11,20,0,0', '11,21,0,0'],
      'el ejemplo muestra el estado inicial, ++ por índice y asignación por índice en líneas distintas',
    );
    assert.ok(aSnapshots.every(array => array.elements.every(element => element.key === `${array.rootId}:${element.index}`)));
    assert.equal(new Set(aSnapshots.map(array => array.rootId)).size, 1, 'la raíz conserva identidad en cada línea');

    const uninitialized = latestByName('sin_inicializar');
    assert.equal(uninitialized.status, 'available');
    assert.deepEqual(
      uninitialized.elements.map(({ initialized, displayValue }) => ({ initialized, displayValue })),
      [
        { initialized: false, displayValue: '?' },
        { initialized: true, displayValue: '7' },
        { initialized: false, displayValue: '?' },
      ],
    );

    const text = latestByName('texto');
    assert.deepEqual(text.elements.map(element => element.displayValue), ["'h'", "'o'", "'l'", "'a'", "'\\0'"]);
    const raw = latestByName('raw');
    assert.deepEqual(raw.elements.map(element => element.displayValue), ["'a'", "'b'", "'c'"]);
    assert.equal(raw.length, 3, 'el array raw no inventa una celda NUL');

    const large = latestByName('grande');
    assert.equal(large.length, 11, 'el largo conserva el número de celdas reales, incluido el NUL');
    assert.equal(large.status, 'too-many-elements');
    assert.deepEqual(large.elements, []);
    const matrix = latestByName('matriz');
    assert.equal(matrix.status, 'multidimensional');
    assert.deepEqual(matrix.elements, []);
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('un literal observado de 11 celdas llega como un solo array y no como preview static', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-overlimit-literal-worker-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 242, fileName: 'main.c',
      source: 'static int puntos[3] = {3, 6};\nchar *global_text = "abcdefghij";\nint main(void) { return 0; }\n',
    } });
    assert.equal(responses[0].type, 'debug-ready');
    assert.equal(responses[0].omittedArrayObjects, 0);
    assert.ok(responses[0].staticObjects.every(object => object.origin !== 'string-literal'));
    const literals = responses[0].arrays.filter(array => array.origin === 'string-literal');
    assert.equal(literals.length, 1);
    assert.ok(Number.isSafeInteger(literals[0].rootId));
    assert.equal(literals[0].region, 'static');
    assert.equal(literals[0].length, 11, 'las diez letras más el NUL cuentan para el límite');
    assert.equal(literals[0].status, 'too-many-elements');
    assert.deepEqual(literals[0].elements, []);
    const staticArray = responses[0].arrays.find(array => array.name === 'puntos');
    assert.ok(staticArray, 'la prueba conserva la cobertura de arrays en Static sin ampliar main.c');
    assert.equal(staticArray.region, 'static');
    assert.equal(staticArray.status, 'available');
    assert.deepEqual(staticArray.elements.map(element => element.displayValue), ['3', '6', '0']);

    scope.onmessage({ data: { type: 'debug-step', jobId: 242, requestId: 1 } });
    const terminal = responses.at(-1);
    assert.equal(terminal.type, 'debug-progress');
    assert.equal(terminal.progress.kind, 'terminated');
    assert.equal(terminal.progress.mainReturn, 0);
    const terminalLiteral = terminal.arrays.find(array => array.origin === 'string-literal');
    assert.equal(terminalLiteral?.rootId, literals[0].rootId, 'el snapshot conserva la identidad rootId');
    assert.equal(terminal.arrays.find(array => array.name === 'puntos')?.rootId, staticArray.rootId);
    assert.ok(terminal.staticObjects.every(object => object.origin !== 'string-literal'));
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('el historial conserva snapshots de arrays inmutables, vuelve con Back/Next y descarta respuestas viejas', () => {
  const { controller, workers } = setupController();
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  const firstArray = arraySnapshot(17, 'a', ['10', '20', '0', '0']);
  const unrelatedArray = arraySnapshot(18, 'fixed', ['4', '5']);
  worker.emit({
    type: 'debug-ready', jobId,
    location: { file: 'main.c', line: 3, column: 1 },
    events: [], heapObjects: [], stackScalars: [], staticObjects: [],
    arrays: [firstArray, unrelatedArray], omittedArrayObjects: 0,
  });

  const originalRoot = controller.state.arrays[0];
  const sharedRoot = controller.state.arrays[1];
  const originalFirstCell = originalRoot.elements[0];
  assert.equal(originalFirstCell.displayValue, '10');
  firstArray.elements[0].displayValue = 'mutación externa';
  firstArray.elements.push({ ...firstArray.elements[0], key: '17:4', index: 4 });
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '10', 'el estado copia también los elementos anidados');
  assert.equal(controller.state.arrays[0].elements.length, 4);
  assert.ok(Object.isFrozen(controller.state.arrays[0]));
  assert.ok(Object.isFrozen(controller.state.arrays[0].elements));
  assert.ok(Object.isFrozen(controller.state.arrays[0].elements[0]));

  controller.next();
  const secondArray = arraySnapshot(17, 'a', ['11', '20', '0', '0']);
  worker.emit({
    type: 'debug-progress', jobId, requestId: 99, progress: paused(4), events: [],
    heapObjects: [], stackScalars: [], staticObjects: [],
    arrays: [arraySnapshot(17, 'a', ['99', '20', '0', '0'])], omittedArrayObjects: 9,
  });
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '10', 'un requestId obsoleto no cambia el snapshot seleccionado');
  assert.equal(controller.state.omittedArrayObjects, 0);

  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(4), events: [],
    heapObjects: [], stackScalars: [], staticObjects: [],
    arrays: [secondArray, arraySnapshot(18, 'fixed', ['4', '5'])], omittedArrayObjects: 1,
  });
  const changedRoot = controller.state.arrays[0];
  assert.equal(changedRoot.elements[0].displayValue, '11');
  assert.equal(changedRoot.elements[1].displayValue, originalRoot.elements[1].displayValue);
  assert.equal(controller.state.arrays[1], sharedRoot, 'una raíz sin cambios mantiene el DTO compartido');
  assert.equal(controller.state.omittedArrayObjects, 1);
  secondArray.elements[0].displayValue = 'mutación posterior';
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '11');

  const sentMessages = worker.messages.length;
  controller.previous();
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '10');
  assert.equal(controller.state.omittedArrayObjects, 0);
  controller.next();
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '11');
  assert.equal(controller.state.omittedArrayObjects, 1);
  assert.equal(worker.messages.length, sentMessages, 'Back/Next recorre los snapshots guardados sin avanzar otra vez el VM');
  assert.equal(originalRoot.elements[0].displayValue, '10', 'el snapshot anterior no se modifica al navegar');

  controller.start('int main(void) { int a[4]; return 0; }');
  const replacementWorker = workers[1];
  const replacementJobId = replacementWorker.messages[0].jobId;
  replacementWorker.emit({
    type: 'debug-ready', jobId: replacementJobId,
    location: { file: 'main.c', line: 1, column: 1 },
    events: [], heapObjects: [], stackScalars: [], staticObjects: [],
    arrays: [arraySnapshot(17, 'a', ['77', '?', '?', '?'], { initialized: [true, false, false, false] })],
    omittedArrayObjects: 0,
  });
  assert.deepEqual(controller.state.arrays[0].elements.map(element => element.displayValue), ['77', '?', '?', '?']);
  assert.equal(controller.state.stepIndex, 0, 'reutilizar el ID de raíz en otra sesión no restaura historia anterior');
  controller.dispose();
});

test('las celdas de arrays producen Δ por elemento y las cadenas no vuelven como tarjeta estática duplicada', () => {
  const previous = arraySnapshot(23, 'buffer', ['1', '2', '3']);
  const next = arraySnapshot(23, 'buffer', ['1', '2', '4']);
  assert.deepEqual(findMemoryViewerChangedArrayElementKeys([previous], [next]), ['23:2']);

  const pendingBefore = arraySnapshot(24, 'pending', ['?', '0'], { initialized: [false, true] });
  const pendingAfter = arraySnapshot(24, 'pending', ['?', '0'], { initialized: [true, true] });
  assert.deepEqual(findMemoryViewerChangedArrayElementKeys([pendingBefore], [pendingAfter]), ['24:0']);
  assert.deepEqual(findMemoryViewerChangedArrayElementKeys([next], [previous]), ['23:2'], 'la selección Back detecta el delta en la dirección elegida');

  const original = {
    ...arraySnapshot(25, 'large', [], { region: 'static' }),
    type: 'char[11]',
    elementType: 'char',
    size: 11,
    length: 11,
    status: 'too-many-elements',
  };
  const cloned = cloneMemoryViewerArraySnapshot(original);
  assert.ok(sameMemoryViewerArraySnapshot(original, cloned));
  assert.notEqual(original.elements, cloned.elements, 'el clone no comparte el arreglo mutable del Worker');
  assert.ok(Object.isFrozen(cloned));
  assert.ok(Object.isFrozen(cloned.elements));

  const staticObjects = [
    { id: 25, origin: 'string-literal', displayValue: 'preview que duplica large' },
    { id: 26, origin: 'string-literal', displayValue: 'literal omitido por maxObjects' },
    { id: 27, origin: 'variable', displayValue: '42' },
  ];
  assert.deepEqual(
    filterMemoryViewerStaticScalars(staticObjects, [cloned]).map(({ id }) => id),
    [27],
    'las cadenas permanecen representadas solo por sus raíces de array, también si falta su raíz por presupuesto',
  );
});
