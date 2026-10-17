import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';

const metrics = {
  prepareMs: 0,
  executeMs: 0,
  sourceChars: 0,
  tokenCount: 0,
  preprocessSteps: 0,
  instructionCount: 0,
  peakMemoryBytes: 0,
};

function paused(line) {
  return { kind: 'paused', location: { file: 'main.c', line, column: 1 }, metrics };
}

function inputNeeded(line, stdout = new Uint8Array(), stderr = new Uint8Array()) {
  return { kind: 'input-needed', location: { file: 'main.c', line, column: 1 }, stdout, stderr, metrics };
}

function terminated() {
  return { kind: 'terminated', exitCode: 0, rawExitStatus: 0, mainReturn: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), metrics };
}

function runtimeError() {
  return {
    kind: 'runtime-error',
    diagnostics: [{ code: 'TEST_ERROR', file: 'main.c', line: 4, column: 1, message: 'error intencional' }],
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    metrics,
  };
}

function lifecycleEvent(sequence, kind = 'scope-enter') {
  return {
    kind,
    sequence,
    location: { file: 'main.c', line: sequence, column: 1 },
    frameId: 1,
    scopeId: 1,
    functionName: 'main',
    scopeName: 'main',
  };
}

function scopeLifecycleEvent(sequence, kind, scopeId, { frameId = 1, functionName = 'main', scopeName = functionName, file = 'main.c' } = {}) {
  return {
    kind,
    sequence,
    location: { file, line: sequence, column: 1 },
    frameId,
    scopeId,
    functionName,
    scopeName,
  };
}

function frameLifecycleEvent(sequence, kind, frameId, functionName) {
  return {
    kind,
    sequence,
    location: { file: 'main.c', line: sequence, column: 1 },
    frameId,
    scopeId: null,
    functionName,
  };
}

function objectLifecycleEvent(sequence, kind, duration, { objectId = sequence, allocationId = objectId, frameId = 1, scopeId = 1, origin = duration === 'heap' ? 'heap' : 'variable', name } = {}) {
  return {
    kind,
    sequence,
    location: { file: 'main.c', line: sequence, column: 1 },
    frameId,
    scopeId,
    objectId,
    allocationId,
    duration,
    origin,
    ...(name === undefined ? {} : { name }),
    typeSummary: 'int',
    addressVirtual: BigInt(allocationId * 4),
    size: 4,
  };
}

function scalarSnapshot({
  id = 41,
  scopeId = 1,
  frameId = 1,
  name = 'value',
  type = 'int',
  origin = 'variable',
  address = '0x1000',
  size = 4,
  initialized = true,
  displayValue = '1',
} = {}) {
  return { id, scopeId, frameId, name, type, origin, address, size, initialized, displayValue };
}

function staticSnapshot({
  id = 100,
  name,
  origin = 'variable',
  type = 'int',
  address = '0x4000',
  size = 4,
  initialized = true,
  displayValue = '1',
} = {}) {
  return { id, ...(name === undefined ? {} : { name }), origin, type, address, size, initialized, displayValue };
}

function staticLiteralArraySnapshot(rootId = 102) {
  return {
    rootId,
    origin: 'string-literal',
    duration: 'static',
    region: 'static',
    frameId: null,
    scopeId: null,
    type: 'char[12]',
    elementType: 'char',
    address: '0x5000',
    size: 12,
    length: 12,
    readOnly: true,
    status: 'too-many-elements',
    elements: [],
  };
}

function heapSnapshot(id, address, size = 8) {
  return { id, address, size, origin: 'heap' };
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

class FakeTimers {
  nextId = 0;
  now = 0;
  timers = new Map();

  setTimeout = (callback, delayMs) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, dueAt: this.now + delayMs });
    return id;
  };

  clearTimeout = id => this.timers.delete(id);

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!due) break;
      const [id, timer] = due;
      this.now = timer.dueAt;
      this.timers.delete(id);
      timer.callback();
    }
    this.now = target;
  }
}

function setup(options = {}) {
  const workers = [];
  const timers = options.timers ?? new FakeTimers();
  const controller = new MemoryViewerController('int main(void) { return 0; }', {
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    timers,
    ...options,
  });
  controller.start();
  return { controller, workers, timers };
}

function ready(worker, line = 1, events = [], stackScalars = [], staticObjects = [], heapObjects = [], arrays = [], omittedArrayObjects = 0) {
  const jobId = worker.messages[0].jobId;
  worker.emit({ type: 'debug-ready', jobId, location: { file: 'main.c', line, column: 1 }, events, stackScalars, staticObjects, heapObjects, arrays, omittedArrayObjects });
  return jobId;
}

test('pasos manuales crean historial navegable sin volver a ejecutar el VM', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1, [lifecycleEvent(1)]);
  assert.equal(controller.state.status, 'paused');
  assert.equal(controller.state.stepIndex, 0);
  assert.equal(controller.state.lifecycle.eventCount, 1);

  controller.next();
  const firstStep = worker.messages[1];
  assert.deepEqual(firstStep, { type: 'debug-step', jobId, requestId: 1 });
  assert.equal(controller.state.status, 'running');
  controller.next();
  assert.equal(worker.messages.length, 2, 'no se envía un segundo paso mientras el primero está pendiente');

  worker.emit({ type: 'debug-progress', jobId, requestId: 99, progress: paused(30), events: [] });
  assert.equal(controller.state.status, 'running', 'se ignoran respuestas de solicitud obsoleta');
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [lifecycleEvent(2)] });
  assert.equal(controller.state.location.line, 2);
  assert.equal(controller.state.stepIndex, 1);
  assert.equal(controller.state.lifecycle.eventCount, 2);

  controller.previous();
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.lifecycle.eventCount, 1);
  controller.next();
  assert.equal(controller.state.location.line, 2);
  assert.equal(worker.messages.length, 2, 'Siguiente consume el historial sin volver a pedir un paso');

  controller.next();
  assert.equal(worker.messages[2].requestId, 2);
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: terminated(), events: [lifecycleEvent(3, 'frame-exit')] });
  assert.equal(controller.state.status, 'terminated');
  assert.equal(controller.state.stepIndex, 2);
  assert.equal(controller.state.canPrevious, true);
  assert.equal(controller.state.canNext, false);
  assert.equal(controller.state.canStop, false);
  assert.equal(worker.terminated, true);

  controller.previous();
  controller.next();
  assert.equal(controller.state.status, 'terminated');
  assert.equal(worker.messages.length, 3, 'navegar el estado terminal tampoco reejecuta la sesión');
});

test('activeScopes reconstruye el orden LIFO desde el setup y el historial en caché', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);

  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);
  assert.deepEqual(controller.state.activeScopes[0], {
    id: 1,
    frameId: 1,
    functionName: 'main',
    scopeName: 'main',
    location: { file: 'main.c', line: 2, column: 1 },
  });

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(3),
    events: [
      scopeLifecycleEvent(3, 'scope-enter', 2, { functionName: 'appendNode', scopeName: 'appendNode' }),
      scopeLifecycleEvent(4, 'scope-enter', 3, { functionName: 'appendNode', scopeName: 'while(...)' }),
    ],
  });
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1, 2, 3]);
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.scopeName), ['main', 'appendNode', 'while(...)']);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(5),
    events: [
      scopeLifecycleEvent(5, 'scope-exit', 3),
      scopeLifecycleEvent(6, 'scope-exit', 2),
    ],
  });
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);

  controller.previous();
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1, 2, 3]);
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.scopeName), ['main', 'appendNode', 'while(...)']);
  controller.next();
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);
  assert.equal(worker.messages.length, 3, 'recorrer el futuro en caché no pide pasos nuevos');
});

test('stackScalars conserva inicialización, asignaciones y objetos por punto histórico', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 2, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);

  assert.deepEqual(controller.state.stackScalars, [], 'entrar en main no publica sus declaraciones futuras');
  assert.ok(Object.isFrozen(controller.state.stackScalars));
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(3),
    events: [scopeLifecycleEvent(3, 'scope-enter', 2, { scopeName: 'block' })],
    stackScalars: [],
  });
  assert.deepEqual(controller.state.stackScalars, [], 'entrar en un bloque no publica declaraciones que aún no se ejecutan');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1, 2]);

  const originalInput = scalarSnapshot({ id: 42, scopeId: 2, name: 'temporal', displayValue: '7' });
  const createEvent = objectLifecycleEvent(4, 'object-create', 'automatic', {
    objectId: 42, allocationId: 42, scopeId: 2, name: 'temporal',
  });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(4), events: [createEvent],
    stackScalars: [originalInput],
  });
  const initializedRecord = controller.state.stackScalars[0];
  assert.equal(initializedRecord.id, createEvent.allocationId, 'el snapshot usa la identidad del objeto publicado');
  assert.equal(initializedRecord.initialized, true);
  assert.equal(initializedRecord.displayValue, '7');
  assert.ok(Object.isFrozen(initializedRecord));
  originalInput.displayValue = 'mutado tras el postMessage';
  assert.equal(controller.state.stackScalars[0].displayValue, '7', 'el historial copia el DTO del Worker');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(5), events: [],
    stackScalars: [scalarSnapshot({ id: 42, scopeId: 2, name: 'temporal', displayValue: '8' })],
  });
  const assignedRecord = controller.state.stackScalars[0];
  assert.equal(assignedRecord.id, initializedRecord.id, 'una asignación conserva la identidad del objeto');
  assert.equal(assignedRecord.displayValue, '8');
  assert.notEqual(assignedRecord, initializedRecord, 'un valor nuevo obtiene un registro histórico nuevo');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 4, progress: paused(6), events: [],
    stackScalars: [scalarSnapshot({ id: 42, scopeId: 2, name: 'temporal', displayValue: '8' })],
  });
  assert.equal(controller.state.stackScalars[0], assignedRecord, 'registros sin cambios se comparten entre entradas');

  const deleteEvent = objectLifecycleEvent(7, 'object-delete', 'automatic', {
    objectId: 42, allocationId: 42, scopeId: 2, name: 'temporal',
  });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 5, progress: paused(8),
    events: [
      deleteEvent,
      scopeLifecycleEvent(8, 'scope-exit', 2, { scopeName: 'block' }),
    ],
    stackScalars: [],
  });
  assert.equal(deleteEvent.allocationId, createEvent.allocationId, 'la salida elimina el mismo objeto publicado por declaration');
  assert.deepEqual(controller.state.stackScalars, [], 'la salida real del scope retira sus escalares');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);

  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '8', 'Atrás restaura el valor anterior a la salida del scope');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '8');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '7');
  controller.previous();
  assert.deepEqual(controller.state.stackScalars, [], 'Atrás restaura el punto entre scope-enter y declaration');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1, 2]);
  controller.next();
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '8');
  assert.equal(worker.messages.length, 6, 'el futuro cacheado no vuelve a ejecutar pasos del VM');
});

test('el historial conserva ?→0 y una asignación al mismo valor no crea un cambio', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  const pending = scalarSnapshot({ id: 42, name: 'pendiente', initialized: false, displayValue: '?' });

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [objectLifecycleEvent(1, 'object-create', 'automatic', { allocationId: 42, name: 'pendiente' })],
    stackScalars: [pending],
  });
  assert.deepEqual(
    controller.state.stackScalars.map(({ initialized, displayValue }) => ({ initialized, displayValue })),
    [{ initialized: false, displayValue: '?' }],
  );

  const initialized = scalarSnapshot({ id: 42, name: 'pendiente', initialized: true, displayValue: '0' });
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [], stackScalars: [initialized] });
  const zeroRecord = controller.state.stackScalars[0];
  assert.equal(zeroRecord.initialized, true);
  assert.equal(zeroRecord.displayValue, '0');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(4), events: [],
    stackScalars: [scalarSnapshot({ id: 42, name: 'pendiente', initialized: true, displayValue: '0' })],
  });
  assert.equal(controller.state.stackScalars[0], zeroRecord, 'repetir el mismo estado reutiliza el snapshot');

  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '0');
  controller.previous();
  assert.deepEqual(
    controller.state.stackScalars.map(({ initialized, displayValue }) => ({ initialized, displayValue })),
    [{ initialized: false, displayValue: '?' }],
  );
  controller.previous();
  assert.deepEqual(controller.state.stackScalars, []);
  controller.next();
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '0', 'Next restaura el mismo snapshot sin ejecutar otra escritura');
  assert.equal(worker.messages.length, 4, 'navegar el historial solo solicita los tres pasos iniciales');
});

test('staticObjects conserva escalares y el historial guarda literales como arrays por punto histórico', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const globalValue = staticSnapshot({ id: 101, name: 'global_value', displayValue: '4' });
  const literalArray = staticLiteralArraySnapshot();
  const jobId = ready(worker, 1, [], [], [globalValue], [], [literalArray]);

  assert.deepEqual(controller.state.stackScalars, []);
  assert.deepEqual(controller.state.staticObjects.map(({ id, name, displayValue }) => [id, name, displayValue]), [
    [101, 'global_value', '4'],
  ]);
  assert.deepEqual(controller.state.arrays.map(({ rootId, region, length, status, elements }) => [rootId, region, length, status, elements]), [
    [102, 'static', 12, 'too-many-elements', []],
  ]);
  assert.ok(Object.isFrozen(controller.state.staticObjects));
  assert.ok(Object.isFrozen(controller.state.staticObjects[0]));
  assert.ok(Object.isFrozen(controller.state.arrays[0].elements));
  globalValue.displayValue = 'mutated after postMessage';
  assert.equal(controller.state.staticObjects[0].displayValue, '4', 'el controller copia el DTO del Worker');

  const updatedGlobal = staticSnapshot({ id: 101, name: 'global_value', displayValue: '5' });
  const localStatic = staticSnapshot({ id: 103, name: 'visits', displayValue: '2' });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [], stackScalars: [],
    staticObjects: [updatedGlobal, localStatic], arrays: [literalArray], omittedArrayObjects: 0,
  });
  assert.deepEqual(controller.state.staticObjects.map(({ name, displayValue }) => [name, displayValue]), [
    ['global_value', '5'],
    ['visits', '2'],
  ]);
  assert.equal(controller.state.arrays[0].rootId, 102, 'el literal conserva la identidad de array entre pausas');

  controller.previous();
  assert.deepEqual(controller.state.staticObjects.map(({ id, displayValue }) => [id, displayValue]), [
    [101, '4'],
  ], 'Atrás reconstruye los estáticos en el punto seleccionado');
  assert.equal(controller.state.arrays[0].rootId, 102, 'Atrás restaura el literal desde su snapshot de array');
  controller.next();
  assert.deepEqual(controller.state.staticObjects.map(({ id, displayValue }) => [id, displayValue]), [
    [101, '5'],
    [103, '2'],
  ]);
  assert.equal(controller.state.arrays[0].rootId, 102, 'Next restaura el mismo literal sin crear un preview static');

  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [], stackScalars: [] });
  assert.deepEqual(controller.state.staticObjects.map(({ id, displayValue }) => [id, displayValue]), [
    [101, '5'],
    [103, '2'],
  ], 'una respuesta antigua sin staticObjects conserva el último snapshot real');
  assert.equal(worker.messages.length, 3, 'volver al frente cacheado y avanzar envía un paso cada vez');
});

test('heapObjects conserva el orden del engine y restaura IDs al navegar free y reutilización de dirección', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);

  const highAddress = heapSnapshot(40, '0x20000000000001', 24);
  const adjacentAddress = heapSnapshot(41, '0x20000000000000', 12);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [
      objectLifecycleEvent(2, 'object-create', 'heap', { allocationId: 40, origin: 'heap' }),
      objectLifecycleEvent(3, 'object-create', 'heap', { allocationId: 41, origin: 'heap' }),
    ],
    heapObjects: [adjacentAddress, highAddress],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [41, 40], 'el historial conserva el orden del engine y las direcciones exactas por encima de 2^53');
  assert.equal(controller.state.hasUsedHeap, true, 'la creación heap real activa la región');
  assert.ok(Object.isFrozen(controller.state.heapObjects));
  assert.ok(Object.isFrozen(controller.state.heapObjects[0]));
  highAddress.address = '0x1';
  assert.equal(controller.state.heapObjects[1].address, '0x20000000000001', 'el controller copia los DTO del Worker');

  const lowAddress = heapSnapshot(42, '0x100', 4);
  const highAddressAgain = heapSnapshot(40, '0x20000000000001', 24);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(3),
    events: [objectLifecycleEvent(4, 'object-create', 'heap', { allocationId: 42, origin: 'heap' })],
    heapObjects: [lowAddress, adjacentAddress, highAddressAgain],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41, 40], 'una inserción puede quedar antes de cualquier tarjeta existente');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(4),
    events: [objectLifecycleEvent(5, 'object-delete', 'heap', { allocationId: 40, origin: 'heap' })],
    heapObjects: [lowAddress, adjacentAddress],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41], 'free quita el ID vivo del snapshot');

  const reusedAddress = heapSnapshot(43, '0x20000000000001', 24);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 4, progress: paused(5),
    events: [objectLifecycleEvent(6, 'object-create', 'heap', { allocationId: 43, origin: 'heap' })],
    heapObjects: [lowAddress, adjacentAddress, reusedAddress],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41, 43]);

  controller.previous();
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41], 'Atrás restaura el estado después de free');
  controller.previous();
  assert.deepEqual(controller.state.heapObjects.map(({ id, address }) => [id, address]), [
    [42, '0x100'],
    [41, '0x20000000000000'],
    [40, '0x20000000000001'],
  ], 'el historial conserva el ID/address de la asignación anterior');
  controller.next();
  controller.next();
  assert.deepEqual(controller.state.heapObjects.map(({ id, address }) => [id, address]), [
    [42, '0x100'],
    [41, '0x20000000000000'],
    [43, '0x20000000000001'],
  ], 'reutilizar una dirección crea otro ID sin confundir las dos vidas');
});

test('el historial copia y restaura el origen parameter/variable junto al valor del scalar', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 2, [
    frameLifecycleEvent(1, 'frame-enter', 2, 'helper'),
    scopeLifecycleEvent(2, 'scope-enter', 2, { frameId: 2, functionName: 'helper' }),
  ]);

  const parameterInput = scalarSnapshot({
    id: 80, scopeId: 2, frameId: 2, name: 'count', origin: 'parameter', displayValue: '2',
  });
  const parameterCreate = objectLifecycleEvent(3, 'object-create', 'automatic', {
    objectId: 80, allocationId: 80, frameId: 2, scopeId: 2, origin: 'parameter', name: 'count',
  });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(3),
    events: [parameterCreate], stackScalars: [parameterInput],
  });

  const savedParameter = controller.state.stackScalars[0];
  assert.equal(savedParameter.origin, 'parameter');
  assert.notEqual(savedParameter, parameterInput, 'el controller clona el DTO recibido del Worker');
  assert.ok(Object.isFrozen(savedParameter));
  parameterInput.origin = 'variable';
  assert.equal(controller.state.stackScalars[0].origin, 'parameter', 'el clon conserva el discriminator');

  const localInput = scalarSnapshot({
    id: 81, scopeId: 2, frameId: 2, name: 'local', origin: 'variable', displayValue: '2',
  });
  const localCreate = objectLifecycleEvent(4, 'object-create', 'automatic', {
    objectId: 81, allocationId: 81, frameId: 2, scopeId: 2, origin: 'variable', name: 'local',
  });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(4),
    events: [localCreate], stackScalars: [savedParameter, localInput],
  });
  assert.deepEqual(controller.state.stackScalars.map(scalar => [scalar.name, scalar.origin, scalar.displayValue]), [
    ['count', 'parameter', '2'],
    ['local', 'variable', '2'],
  ]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(5), events: [],
    stackScalars: [savedParameter, scalarSnapshot({
      id: 81, scopeId: 2, frameId: 2, name: 'local', origin: 'variable', displayValue: '3',
    })],
  });
  assert.equal(controller.state.stackScalars[1].displayValue, '3');

  controller.previous();
  assert.deepEqual(controller.state.stackScalars.map(scalar => [scalar.name, scalar.origin, scalar.displayValue]), [
    ['count', 'parameter', '2'],
    ['local', 'variable', '2'],
  ], 'Atrás restaura origen y valor del snapshot en caché');
  controller.previous();
  assert.deepEqual(controller.state.stackScalars.map(({ name, origin }) => [name, origin]), [['count', 'parameter']]);
  controller.next();
  assert.deepEqual(controller.state.stackScalars.map(({ name, origin }) => [name, origin]), [
    ['count', 'parameter'],
    ['local', 'variable'],
  ]);
  assert.equal(worker.messages.length, 4, 'navegar los snapshots guardados no solicita pasos nuevos');
});

test('el límite del historial conserva snapshots, errores retienen el último valor y start los reinicia', () => {
  const { controller, workers } = setup({ maxHistoryEntries: 2 });
  const worker = workers[0];
  let jobId = ready(worker, 1);
  assert.deepEqual(controller.state.stackScalars, []);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [objectLifecycleEvent(1, 'object-create', 'automatic', { allocationId: 41, objectId: 41 })],
    stackScalars: [scalarSnapshot({ displayValue: '2' })],
  });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [],
    stackScalars: [scalarSnapshot({ displayValue: '3' })],
  });
  assert.equal(controller.state.stackScalars[0].displayValue, '3');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '2');
  assert.equal(controller.state.canPrevious, false, 'el snapshot podado tampoco se puede recuperar');
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '3');
  assert.equal(worker.messages.length, 3, 'volver al frente cacheado no manda un mensaje duplicado');

  controller.next();
  worker.emit({
    type: 'debug-error', jobId, requestId: 3, status: 'error', message: 'fallo intencional',
  });
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.stackScalars[0].displayValue, '3', 'un error conserva la última inspección real');

  controller.start();
  assert.deepEqual(controller.state.stackScalars, [], 'una sesión nueva no hereda snapshots anteriores');
  jobId = ready(workers[1], 1);
  controller.next();
  workers[1].emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [],
    stackScalars: [scalarSnapshot({ displayValue: '9' })],
  });
  assert.equal(controller.state.stackScalars[0].displayValue, '9');
  controller.next();
  workers[1].emit({
    type: 'debug-progress', jobId, requestId: 999, progress: paused(90), events: [],
    stackScalars: [scalarSnapshot({ displayValue: 'stale' })],
  });
  assert.equal(controller.state.stackScalars[0].displayValue, '9', 'una respuesta de paso obsoleta se ignora');
});

test('los checkpoints de escalares conservan Back y el futuro cacheado después de podar', () => {
  const { controller, workers } = setup({ maxHistoryEntries: 3 });
  const worker = workers[0];
  const jobId = ready(worker, 1);
  assert.deepEqual(controller.state.stackScalars, []);

  for (let value = 1; value <= 130; value += 1) {
    controller.next();
    worker.emit({
      type: 'debug-progress', jobId, requestId: value, progress: paused(value + 1),
      events: value === 1
        ? [objectLifecycleEvent(1, 'object-create', 'automatic', { allocationId: 41, objectId: 41 })]
        : [],
      stackScalars: [scalarSnapshot({ displayValue: String(value) })],
    });
  }

  assert.equal(controller.state.stepIndex, 130);
  assert.equal(controller.state.stackScalars[0].displayValue, '130');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '129');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '128');
  assert.equal(controller.state.canPrevious, false, 'el límite conserva solo las tres entradas recientes');
  const messageCount = worker.messages.length;
  controller.next();
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '130');
  assert.equal(worker.messages.length, messageCount, 'el futuro posterior al checkpoint sigue cacheado');
});

test('scope de una llamada entra después del frame y el retorno consume sus cierres reales', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(8),
    events: [
      frameLifecycleEvent(3, 'frame-enter', 2, 'helper'),
      scopeLifecycleEvent(4, 'scope-enter', 2, { frameId: 2, functionName: 'helper', file: 'helper.c' }),
    ],
  });
  assert.deepEqual(controller.state.activeScopes.map(scope => [scope.id, scope.functionName]), [
    [1, 'main'],
    [2, 'helper'],
  ]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(2),
    events: [
      scopeLifecycleEvent(5, 'scope-exit', 2, { frameId: 2, functionName: 'helper', file: 'helper.c' }),
      frameLifecycleEvent(6, 'frame-exit', 2, 'helper'),
    ],
  });
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: terminated(),
    events: [
      scopeLifecycleEvent(7, 'scope-exit', 1),
      frameLifecycleEvent(8, 'frame-exit', 1, 'main'),
    ],
  });
  assert.equal(controller.state.status, 'terminated');
  assert.deepEqual(controller.state.activeScopes, []);
});

test('un error conserva los scopes que el motor no cerró y una sesión nueva los reinicia', () => {
  const { controller, workers } = setup();
  const firstJobId = ready(workers[0], 1, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);

  controller.next();
  workers[0].emit({
    type: 'debug-progress', jobId: firstJobId, requestId: 1, progress: runtimeError(),
    events: [frameLifecycleEvent(3, 'frame-exit', 1, 'main')],
  });
  assert.equal(controller.state.status, 'error');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1], 'frame-exit no inventa un scope-exit');

  controller.start();
  assert.deepEqual(controller.state.activeScopes, []);
  ready(workers[1], 1, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);
});

test('un límite de eventos conserva los scopes activos sin fabricar cierres', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [objectLifecycleEvent(1, 'object-create', 'automatic', { allocationId: 41, objectId: 41 })],
    stackScalars: [scalarSnapshot({ displayValue: '6' })],
  });

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2,
    progress: {
      kind: 'debug-limit',
      resource: 'maxDebugEvents',
      limit: 100_000,
      diagnostics: [{ code: 'DEBUG_EVENT_LIMIT', file: 'main.c', line: 3, column: 1, message: 'límite alcanzado' }],
      metrics,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    },
    events: [],
  });

  assert.equal(controller.state.status, 'limit');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);
  assert.equal(controller.state.stackScalars[0].displayValue, '6', 'el límite conserva la última inspección real');
});

test('los scopes activos persisten al recortar el historial navegable', () => {
  const { controller, workers } = setup({ maxHistoryEntries: 2 });
  const worker = workers[0];
  const jobId = ready(worker, 1, [scopeLifecycleEvent(1, 'scope-enter', 10)]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [scopeLifecycleEvent(2, 'scope-enter', 11)],
  });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(3),
    events: [scopeLifecycleEvent(3, 'scope-exit', 11)],
  });
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [10]);

  controller.previous();
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [10, 11]);
  controller.next();
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [10]);
  assert.equal(worker.messages.length, 3);
});

test('hasUsedHeap solo cambia con una asignación heap real y persiste al liberar o navegar atrás', () => {
  const { controller, workers } = setup();
  const worker = workers[0];

  assert.equal(controller.state.hasUsedHeap, false);
  const jobId = ready(worker, 1, [
    objectLifecycleEvent(1, 'object-create', 'automatic'),
    objectLifecycleEvent(2, 'object-create', 'static'),
  ]);
  assert.equal(controller.state.hasUsedHeap, false, 'los objetos automáticos y static no cuentan como heap');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [objectLifecycleEvent(3, 'object-create', 'heap')],
  });
  assert.equal(controller.state.hasUsedHeap, true, 'la asignación heap recibida al avanzar se reconoce');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(3),
    events: [objectLifecycleEvent(4, 'object-delete', 'heap')],
  });
  assert.equal(controller.state.hasUsedHeap, true, 'liberar el objeto no borra el uso histórico de heap');

  controller.previous();
  controller.previous();
  assert.equal(controller.state.lifecycle.eventCount, 2, 'el punto seleccionado queda antes del evento heap');
  assert.equal(controller.state.hasUsedHeap, true, 'Atrás no reinicia la señal de la sesión');

  controller.start();
  assert.equal(controller.state.hasUsedHeap, false, 'una sesión nueva reinicia la señal');
  ready(workers[1]);
  assert.equal(controller.state.hasUsedHeap, false, 'una sesión nueva sin heap permanece en false');
});

test('hasUsedHeap detecta una asignación incluida en los eventos iniciales de preparación', () => {
  const { controller, workers } = setup();
  ready(workers[0], 1, [objectLifecycleEvent(1, 'object-create', 'heap')]);
  assert.equal(controller.state.hasUsedHeap, true);
});

test('Play espera 500 ms, impide solapamientos y se detiene con Atrás', () => {
  const { controller, workers, timers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);

  controller.togglePlay();
  assert.equal(controller.state.isPlaying, true);
  timers.advance(499);
  assert.equal(worker.messages.length, 1);
  timers.advance(1);
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].requestId, 1);

  timers.advance(4_000);
  assert.equal(worker.messages.length, 2, 'no se apilan pasos mientras el Worker no responde');
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [] });
  assert.equal(controller.state.status, 'paused');
  assert.equal(controller.state.isPlaying, true);
  timers.advance(499);
  assert.equal(worker.messages.length, 2);
  timers.advance(1);
  assert.equal(worker.messages.length, 3);

  controller.previous();
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.isPlaying, false);
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [] });
  assert.equal(controller.state.location.line, 1, 'la respuesta pendiente queda en el futuro del historial');
  assert.equal(controller.state.canNext, true);
  timers.advance(1_000);
  assert.equal(worker.messages.length, 3, 'Atrás cancela los ticks pendientes');
  controller.next();
  controller.next();
  assert.equal(controller.state.location.line, 3);
  assert.equal(worker.messages.length, 3, 'el futuro del historial se recorre sin consumir otra vez el VM');
});

test('historial y eventos respetan el límite, y dispose cancela timers y Worker', () => {
  const { controller, workers, timers } = setup({ maxHistoryEntries: 2 });
  const worker = workers[0];
  const jobId = ready(worker, 1, [lifecycleEvent(1)]);
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [lifecycleEvent(2)] });
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [lifecycleEvent(3)] });
  assert.equal(controller.state.stepIndex, 2);
  assert.equal(controller.state.lifecycle.eventCount, 3, 'los eventos de lifecycle conservan el prefijo tras recortar ubicaciones viejas');
  assert.match(controller.state.historyNotice, /límite|historial conserva/u);
  assert.equal(controller.state.canPrevious, true);

  controller.previous();
  assert.equal(controller.state.stepIndex, 1);
  assert.equal(controller.state.canPrevious, false, 'el inicio navegable avanza con el límite del historial');
  assert.equal(controller.state.lifecycle.eventCount, 2);
  assert.match(controller.state.historyNotice, /más antiguos ya no están disponibles/u);
  controller.next();
  assert.equal(controller.state.location.line, 3);
  assert.equal(worker.messages.length, 3);

  controller.togglePlay();
  assert.equal(timers.timers.size, 1);
  controller.dispose();
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null);
  assert.equal(timers.timers.size, 0);
});

test('los job IDs obsoletos no cambian el estado, y la preparación informa diagnósticos', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  worker.emit({ type: 'debug-progress', jobId: jobId - 1, requestId: 1, progress: paused(9), events: [] });
  assert.equal(controller.state.location.line, 1);

  controller.dispose();
  controller.start('int main(void) {');
  const replacement = workers[1];
  const replacementId = replacement.messages[0].jobId;
  replacement.emit({
    type: 'debug-error', jobId: replacementId, requestId: null, status: 'error',
    message: 'main.c:1:1: falta cerrar el bloque',
  });
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.errorMessage, 'main.c:1:1: falta cerrar el bloque');
});

test('el watchdog cubre preparación y pasos, pero no la espera entre ticks o acciones', () => {
  const configuration = { ...RUN_CONFIGURATION, timeoutMs: 100 };
  const { controller, workers, timers } = setup({ configuration });
  const worker = workers[0];

  timers.advance(99);
  assert.equal(controller.state.status, 'starting');
  ready(worker, 1);
  timers.advance(10_000);
  assert.equal(controller.state.status, 'paused', 'el tiempo en espera de usuario no consume el watchdog');

  controller.next();
  timers.advance(99);
  assert.equal(controller.state.status, 'running');
  timers.advance(1);
  assert.equal(controller.state.status, 'error');
  assert.match(controller.state.errorMessage, /tiempo máximo de 100 ms/u);
  assert.equal(worker.terminated, true);

  const preparing = setup({ configuration });
  preparing.timers.advance(100);
  assert.equal(preparing.controller.state.status, 'error');
  assert.equal(preparing.workers[0].terminated, true);
});

test('I/O apagado responde EOF al primer input-needed sin publicar una espera oculta', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  controller.setStdinInteractiveEnabled(false);
  controller.next();

  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 7, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });

  assert.deepEqual(worker.messages.at(-1), {
    type: 'debug-stdin-eof', jobId, requestId: 1, inputRequestId: 7,
  });
  assert.equal(controller.state.status, 'running');
  assert.equal(controller.state.inputRequestId, null);
  assert.equal(controller.state.stepIndex, 0, 'EOF continúa el mismo paso sin crear historial');
  assert.ok(controller.state.transcript.some(entry => entry.text === '[EOF]\n'));
  assert.equal(controller.sendStdinLine('9'), false);

  const messageCount = worker.messages.length;
  controller.setStdinInteractiveEnabled(true);
  assert.equal(worker.messages.length, messageCount, 'reactivar I/O no reabre stdin después de EOF');
});

test('I/O apagado cierra la espera desde el historial sin mover su cursor', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [] });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, inputRequestId: 13, progress: inputNeeded(3), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });
  controller.previous();
  assert.equal(controller.state.isViewingHistory, true);
  assert.equal(controller.state.inputRequestId, null, 'el formulario de stdin queda oculto en el historial');

  controller.setStdinInteractiveEnabled(false);
  assert.deepEqual(worker.messages.at(-1), {
    type: 'debug-stdin-eof', jobId, requestId: 2, inputRequestId: 13,
  });
  assert.equal(controller.state.stepIndex, 0);
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.isViewingHistory, true);

  const messageCount = worker.messages.length;
  controller.setStdinInteractiveEnabled(true);
  assert.equal(controller.sendStdinLine('ignored'), false, 'el token interno ya quedó cerrado');
  assert.equal(worker.messages.length, messageCount, 'I/O vuelve a mostrarse sin reiniciar la sesión');

  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: terminated(), events: [] });
  assert.equal(controller.state.stepIndex, 0, 'la respuesta del paso pendiente conserva el cursor histórico');
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.isViewingHistory, true);
});

test('I/O encendido mantiene la entrada interactiva habitual', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  controller.setStdinInteractiveEnabled(true);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 21, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });

  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 21);
  assert.equal(worker.messages.length, 2, 'no se envía EOF con I/O encendido');
  assert.equal(controller.sendStdinLine('5'), true);
  assert.deepEqual(worker.messages.at(-1), {
    type: 'debug-stdin', jobId, requestId: 1, inputRequestId: 21,
    bytes: new TextEncoder().encode('5\n'),
  });
});

test('stdin mantiene el mismo paso a través de esperas repetidas y conserva salida/historial monotónicos', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  controller.next();
  const step = worker.messages[1];

  worker.emit({ type: 'debug-output', jobId, requestId: step.requestId, sequence: 1, stream: 'stdout', chunk: new TextEncoder().encode('prompt> ') });
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'prompt> ', 'la salida aparece antes del primer wait');
  worker.emit({ type: 'debug-output', jobId, requestId: 99, sequence: 2, stream: 'stdout', chunk: new TextEncoder().encode('stale') });
  worker.emit({
    type: 'debug-progress', jobId, requestId: step.requestId, inputRequestId: 1,
    progress: inputNeeded(2), events: [objectLifecycleEvent(2, 'object-create', 'heap')],
    heapObjects: [heapSnapshot(1, '0x1000')], pointers: [], arrays: [], omittedArrayObjects: 0,
    aggregates: [], omittedAggregateObjects: 0, stackScalars: [], staticObjects: [],
  });
  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 1);
  assert.equal(controller.state.stepIndex, 0, 'la espera no crea una ubicación histórica');
  assert.equal(controller.state.lifecycle.eventCount, 1, 'los eventos transitorios se conservan una vez');
  assert.equal(controller.sendStdinLine('12'), true);
  assert.deepEqual(worker.messages.at(-1), {
    type: 'debug-stdin', jobId, requestId: step.requestId, inputRequestId: 1,
    bytes: new TextEncoder().encode('12\n'),
  });

  worker.emit({ type: 'debug-output', jobId, requestId: step.requestId, sequence: 2, stream: 'stdout', chunk: new TextEncoder().encode('part 12 ') });
  worker.emit({ type: 'debug-output', jobId, requestId: step.requestId, sequence: 2, stream: 'stdout', chunk: new TextEncoder().encode('duplicate') });
  worker.emit({
    type: 'debug-progress', jobId, requestId: step.requestId, inputRequestId: 2,
    progress: inputNeeded(2), events: [objectLifecycleEvent(3, 'object-create', 'heap')],
    heapObjects: [heapSnapshot(1, '0x1000'), heapSnapshot(2, '0x1008')], pointers: [], arrays: [], omittedArrayObjects: 0,
    aggregates: [], omittedAggregateObjects: 0, stackScalars: [scalarSnapshot({ displayValue: '12' })], staticObjects: [],
  });
  assert.equal(controller.state.inputRequestId, 2, 'cada parada real de entrada recibe un token nuevo');
  assert.equal(controller.state.stepIndex, 0, 'el segundo wait sigue sin añadir historia');
  assert.equal(controller.state.stackScalars[0].displayValue, '12', 'se muestra la conversión ya asignada antes del segundo wait');
  assert.equal(controller.state.lifecycle.eventCount, 2);
  assert.equal(controller.sendStdinLine('34'), true);
  assert.equal(worker.messages.at(-1).requestId, step.requestId, 'la continuación reusa el request del mismo paso');
  assert.equal(worker.messages.at(-1).inputRequestId, 2);

  worker.emit({ type: 'debug-output', jobId, requestId: step.requestId, sequence: 3, stream: 'stdout', chunk: new TextEncoder().encode('34\n') });
  worker.emit({
    type: 'debug-progress', jobId, requestId: step.requestId, progress: paused(3), events: [objectLifecycleEvent(4, 'object-delete', 'heap')],
    heapObjects: [heapSnapshot(1, '0x1000')], pointers: [], arrays: [], omittedArrayObjects: 0,
    aggregates: [], omittedAggregateObjects: 0, stackScalars: [scalarSnapshot({ displayValue: '46' })], staticObjects: [],
  });
  assert.equal(controller.state.status, 'paused');
  assert.equal(controller.state.stepIndex, 1, 'el request pendiente crea una sola entrada al pausar');
  assert.equal(controller.state.inputRequestId, null);
  assert.equal(controller.state.lifecycle.eventCount, 3, 'los eventos de las dos esperas y la pausa se agregan sin perderse');
  assert.equal(controller.state.heapObjects.length, 1, 'las instantáneas finales reemplazan el estado transitorio');

  const transcriptBeforeHistory = controller.state.transcript;
  const outputText = transcriptBeforeHistory.map(entry => entry.text).join('');
  assert.equal(outputText, 'prompt> 12\npart 12 34\n34\n');
  const messageCount = worker.messages.length;
  controller.previous();
  assert.equal(controller.state.isViewingHistory, true);
  assert.equal(controller.state.inputRequestId, null);
  assert.equal(controller.state.canStop, true, 'Stop sigue disponible al recorrer historia mientras la VM vive');
  controller.next();
  assert.equal(controller.state.transcript, transcriptBeforeHistory, 'navegar snapshots no vuelve a emitir salida ni stdin');
  assert.equal(worker.messages.length, messageCount);
});

test('EOF usa el token de la espera una sola vez y Stop conserva salida e historial parcial', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  controller.next();
  worker.emit({ type: 'debug-output', jobId, requestId: 1, sequence: 1, stream: 'stderr', chunk: new TextEncoder().encode('diagnóstico parcial') });
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 41, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });
  assert.equal(controller.sendStdinEOF(), true);
  assert.equal(controller.sendStdinEOF(), false);
  assert.equal(controller.sendStdinLine('ignored'), false);
  assert.deepEqual(worker.messages.at(-1), { type: 'debug-stdin-eof', jobId, requestId: 1, inputRequestId: 41 });
  assert.ok(controller.state.transcript.some(entry => entry.text === '[EOF]\n'));

  controller.stop();
  assert.equal(controller.state.status, 'cancelled');
  assert.equal(controller.state.canStop, false);
  assert.equal(controller.state.stepIndex, 1);
  assert.equal(worker.terminated, true);
  assert.ok(controller.state.transcript.some(entry => entry.text === 'diagnóstico parcial'));
  const transcript = controller.state.transcript;
  worker.emit({ type: 'debug-output', jobId, requestId: 1, sequence: 2, stream: 'stderr', chunk: new TextEncoder().encode('tarde') });
  assert.equal(controller.state.transcript, transcript, 'la salida tardía tras Stop queda descartada');
  assert.equal(controller.sendStdinEOF(), false);
});

test('una espera de stdin queda oculta en historia vieja y reaparece al volver a su frontera', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  assert.equal(controller.state.canStop, true, 'Stop sigue disponible mientras la VM pausada permanece viva');
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [] });
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, inputRequestId: 13, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });

  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 13);
  assert.equal(controller.state.canStop, true);
  controller.previous();
  assert.equal(controller.state.isViewingHistory, true);
  assert.equal(controller.state.status, 'paused');
  assert.equal(controller.state.inputRequestId, null, 'no se proyecta al pasado el formulario de la VM viva');
  assert.equal(controller.sendStdinLine('invalido'), false);
  assert.equal(controller.state.canStop, true);

  controller.next();
  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 13, 'la misma petición reaparece al volver al frontier');
  assert.equal(worker.messages.length, 3, 'recorrer el futuro cacheado no envía otro debug-step');
  assert.equal(controller.sendStdinLine('5'), true);
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [] });
  assert.equal(controller.state.status, 'paused');
  controller.previous();
  assert.equal(controller.state.canStop, true, 'el VM pausado sigue siendo cancelable desde cualquier paso visible');
});

test('el watchdog se pausa durante el wait y vuelve a contar al enviar stdin', () => {
  const configuration = { ...RUN_CONFIGURATION, timeoutMs: 100 };
  const { controller, workers, timers } = setup({ configuration });
  const worker = workers[0];
  const jobId = ready(worker);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 7, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });
  timers.advance(10_000);
  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.sendStdinLine('3'), true);
  timers.advance(99);
  assert.equal(controller.state.status, 'running');
  timers.advance(1);
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.canStop, false);
  assert.equal(worker.terminated, true);
});
