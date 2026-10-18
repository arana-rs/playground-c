import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';
import { TerminalPresentation } from '../src/components/terminalPresentation.ts';
import { formatConsoleSegments } from '../src/execution/useRunner.ts';
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
    diagnostics: [{ code: 'TEST_ERROR', file: 'main.c', line: 4, column: 1, message: 'intentional error' }],
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

test('manual steps create navigable history without rerunning the VM', () => {
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
  assert.equal(worker.messages.length, 2, 'a second step is not sent while the first is pending');

  worker.emit({ type: 'debug-progress', jobId, requestId: 99, progress: paused(30), events: [] });
  assert.equal(controller.state.status, 'running', 'responses to stale requests are ignored');
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [lifecycleEvent(2)] });
  assert.equal(controller.state.location.line, 2);
  assert.equal(controller.state.stepIndex, 1);
  assert.equal(controller.state.lifecycle.eventCount, 2);

  controller.previous();
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.lifecycle.eventCount, 1);
  controller.next();
  assert.equal(controller.state.location.line, 2);
  assert.equal(worker.messages.length, 2, 'Next consumes history without requesting another step');

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
  assert.equal(worker.messages.length, 3, 'navigating the terminal state does not rerun the session');
});

test('activeScopes rebuilds LIFO order from setup and cached history', () => {
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
  assert.equal(worker.messages.length, 3, 'traversing cached future does not request new steps');
});

test('stackScalars retains initialization, assignments, and objects at each history point', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 2, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);

  assert.deepEqual(controller.state.stackScalars, [], 'entering main does not publish its future declarations');
  assert.ok(Object.isFrozen(controller.state.stackScalars));
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(3),
    events: [scopeLifecycleEvent(3, 'scope-enter', 2, { scopeName: 'block' })],
    stackScalars: [],
  });
  assert.deepEqual(controller.state.stackScalars, [], 'entering a block does not publish declarations that have not executed');
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
  assert.equal(initializedRecord.id, createEvent.allocationId, 'the snapshot uses the identity of the published object');
  assert.equal(initializedRecord.initialized, true);
  assert.equal(initializedRecord.displayValue, '7');
  assert.ok(Object.isFrozen(initializedRecord));
  originalInput.displayValue = 'mutated after postMessage';
  assert.equal(controller.state.stackScalars[0].displayValue, '7', 'history copies the Worker DTO');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(5), events: [],
    stackScalars: [scalarSnapshot({ id: 42, scopeId: 2, name: 'temporal', displayValue: '8' })],
  });
  const assignedRecord = controller.state.stackScalars[0];
  assert.equal(assignedRecord.id, initializedRecord.id, 'an assignment retains the object identity');
  assert.equal(assignedRecord.displayValue, '8');
  assert.notEqual(assignedRecord, initializedRecord, 'a new value gets a new history record');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 4, progress: paused(6), events: [],
    stackScalars: [scalarSnapshot({ id: 42, scopeId: 2, name: 'temporal', displayValue: '8' })],
  });
  assert.equal(controller.state.stackScalars[0], assignedRecord, 'unchanged records are shared between entries');

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
  assert.equal(deleteEvent.allocationId, createEvent.allocationId, 'scope exit deletes the same object published by declaration');
  assert.deepEqual(controller.state.stackScalars, [], 'actual scope exit removes its scalars');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);

  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '8', 'Back restores the value from before scope exit');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '8');
  controller.previous();
  assert.equal(controller.state.stackScalars[0].displayValue, '7');
  controller.previous();
  assert.deepEqual(controller.state.stackScalars, [], 'Back restores the point between scope-enter and declaration');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1, 2]);
  controller.next();
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '8');
  assert.equal(worker.messages.length, 6, 'cached future does not rerun VM steps');
});

test('history retains ?→0 and an assignment to the same value creates no change', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  const pending = scalarSnapshot({ id: 42, name: 'uninitialized', initialized: false, displayValue: '?' });

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [objectLifecycleEvent(1, 'object-create', 'automatic', { allocationId: 42, name: 'uninitialized' })],
    stackScalars: [pending],
  });
  assert.deepEqual(
    controller.state.stackScalars.map(({ initialized, displayValue }) => ({ initialized, displayValue })),
    [{ initialized: false, displayValue: '?' }],
  );

  const initialized = scalarSnapshot({ id: 42, name: 'uninitialized', initialized: true, displayValue: '0' });
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [], stackScalars: [initialized] });
  const zeroRecord = controller.state.stackScalars[0];
  assert.equal(zeroRecord.initialized, true);
  assert.equal(zeroRecord.displayValue, '0');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(4), events: [],
    stackScalars: [scalarSnapshot({ id: 42, name: 'uninitialized', initialized: true, displayValue: '0' })],
  });
  assert.equal(controller.state.stackScalars[0], zeroRecord, 'repeating the same state reuses the snapshot');

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
  assert.equal(controller.state.stackScalars[0].displayValue, '0', 'Next restores the same snapshot without another write');
  assert.equal(worker.messages.length, 4, 'history navigation only requests the first three steps');
});

test('staticObjects retains scalars and history stores literals as arrays at each history point', () => {
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
  assert.equal(controller.state.staticObjects[0].displayValue, '4', 'the controller copies the Worker DTO');

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
  assert.equal(controller.state.arrays[0].rootId, 102, 'the literal retains its array identity across pauses');

  controller.previous();
  assert.deepEqual(controller.state.staticObjects.map(({ id, displayValue }) => [id, displayValue]), [
    [101, '4'],
  ], 'Back rebuilds static objects at the selected point');
  assert.equal(controller.state.arrays[0].rootId, 102, 'Back restores the literal from its array snapshot');
  controller.next();
  assert.deepEqual(controller.state.staticObjects.map(({ id, displayValue }) => [id, displayValue]), [
    [101, '5'],
    [103, '2'],
  ]);
  assert.equal(controller.state.arrays[0].rootId, 102, 'Next restores the same literal without creating a static preview');

  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [], stackScalars: [] });
  assert.deepEqual(controller.state.staticObjects.map(({ id, displayValue }) => [id, displayValue]), [
    [101, '5'],
    [103, '2'],
  ], 'an old response without staticObjects retains the latest real snapshot');
  assert.equal(worker.messages.length, 3, 'returning to cached latest state and advancing sends one step at a time');
});

test('heapObjects retains engine order and restores IDs while navigating free and address reuse', () => {
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
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [41, 40], 'history retains engine order and exact addresses above 2^53');
  assert.equal(controller.state.hasUsedHeap, true, 'a real heap allocation activates the region');
  assert.ok(Object.isFrozen(controller.state.heapObjects));
  assert.ok(Object.isFrozen(controller.state.heapObjects[0]));
  highAddress.address = '0x1';
  assert.equal(controller.state.heapObjects[1].address, '0x20000000000001', 'the controller copies the Worker DTOs');

  const lowAddress = heapSnapshot(42, '0x100', 4);
  const highAddressAgain = heapSnapshot(40, '0x20000000000001', 24);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(3),
    events: [objectLifecycleEvent(4, 'object-create', 'heap', { allocationId: 42, origin: 'heap' })],
    heapObjects: [lowAddress, adjacentAddress, highAddressAgain],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41, 40], 'an insertion can appear before any existing card');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 3, progress: paused(4),
    events: [objectLifecycleEvent(5, 'object-delete', 'heap', { allocationId: 40, origin: 'heap' })],
    heapObjects: [lowAddress, adjacentAddress],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41], 'free removes the live ID from the snapshot');

  const reusedAddress = heapSnapshot(43, '0x20000000000001', 24);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 4, progress: paused(5),
    events: [objectLifecycleEvent(6, 'object-create', 'heap', { allocationId: 43, origin: 'heap' })],
    heapObjects: [lowAddress, adjacentAddress, reusedAddress],
  });
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41, 43]);

  controller.previous();
  assert.deepEqual(controller.state.heapObjects.map(({ id }) => id), [42, 41], 'Back restores the state after free');
  controller.previous();
  assert.deepEqual(controller.state.heapObjects.map(({ id, address }) => [id, address]), [
    [42, '0x100'],
    [41, '0x20000000000000'],
    [40, '0x20000000000001'],
  ], 'history retains the ID/address from the previous allocation');
  controller.next();
  controller.next();
  assert.deepEqual(controller.state.heapObjects.map(({ id, address }) => [id, address]), [
    [42, '0x100'],
    [41, '0x20000000000000'],
    [43, '0x20000000000001'],
  ], 'reusing an address creates another ID without confusing the two lifetimes');
});

test('history copies and restores parameter/variable origin with the scalar value', () => {
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
  assert.notEqual(savedParameter, parameterInput, 'the controller clones the DTO received from the Worker');
  assert.ok(Object.isFrozen(savedParameter));
  parameterInput.origin = 'variable';
  assert.equal(controller.state.stackScalars[0].origin, 'parameter', 'the clone retains the discriminator');

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
  ], 'Back restores origin and value from the cached snapshot');
  controller.previous();
  assert.deepEqual(controller.state.stackScalars.map(({ name, origin }) => [name, origin]), [['count', 'parameter']]);
  controller.next();
  assert.deepEqual(controller.state.stackScalars.map(({ name, origin }) => [name, origin]), [
    ['count', 'parameter'],
    ['local', 'variable'],
  ]);
  assert.equal(worker.messages.length, 4, 'navigating saved snapshots does not request new steps');
});

test('history limit retains snapshots, errors keep the latest value, and start resets them', () => {
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
  assert.equal(controller.state.canPrevious, false, 'the pruned snapshot cannot be restored either');
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '3');
  assert.equal(worker.messages.length, 3, 'returning to cached latest state does not send a duplicate message');

  controller.next();
  worker.emit({
    type: 'debug-error', jobId, requestId: 3, status: 'error', message: 'intentional failure',
  });
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.stackScalars[0].displayValue, '3', 'an error retains the latest real inspection');

  controller.start();
  assert.deepEqual(controller.state.stackScalars, [], 'a new session does not inherit previous snapshots');
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
  assert.equal(controller.state.stackScalars[0].displayValue, '9', 'a stale step response is ignored');
});

test('scalar checkpoints retain Back and cached future after pruning', () => {
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
  assert.equal(controller.state.canPrevious, false, 'the limit retains only the three most recent entries');
  const messageCount = worker.messages.length;
  controller.next();
  controller.next();
  assert.equal(controller.state.stackScalars[0].displayValue, '130');
  assert.equal(worker.messages.length, messageCount, 'future after the checkpoint remains cached');
});

test('a call scope enters after its frame and return consumes its actual exits', () => {
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

test('an error retains scopes the engine did not close, and a new session resets them', () => {
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
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1], 'frame-exit does not invent a scope-exit');

  controller.start();
  assert.deepEqual(controller.state.activeScopes, []);
  ready(workers[1], 1, [
    frameLifecycleEvent(1, 'frame-enter', 1, 'main'),
    scopeLifecycleEvent(2, 'scope-enter', 1),
  ]);
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);
});

test('an event limit retains active scopes without fabricating exits', () => {
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
      diagnostics: [{ code: 'DEBUG_EVENT_LIMIT', file: 'main.c', line: 3, column: 1, message: 'limit reached' }],
      metrics,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    },
    events: [],
  });

  assert.equal(controller.state.status, 'limit');
  assert.deepEqual(controller.state.activeScopes.map(scope => scope.id), [1]);
  assert.equal(controller.state.stackScalars[0].displayValue, '6', 'the limit retains the latest real inspection');
});

test('active scopes persist when navigable history is pruned', () => {
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

test('hasUsedHeap changes only with a real heap allocation and persists across free or Back', () => {
  const { controller, workers } = setup();
  const worker = workers[0];

  assert.equal(controller.state.hasUsedHeap, false);
  const jobId = ready(worker, 1, [
    objectLifecycleEvent(1, 'object-create', 'automatic'),
    objectLifecycleEvent(2, 'object-create', 'static'),
  ]);
  assert.equal(controller.state.hasUsedHeap, false, 'automatic and static objects do not count as heap');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, progress: paused(2),
    events: [objectLifecycleEvent(3, 'object-create', 'heap')],
  });
  assert.equal(controller.state.hasUsedHeap, true, 'the heap allocation received while advancing is recognized');

  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 2, progress: paused(3),
    events: [objectLifecycleEvent(4, 'object-delete', 'heap')],
  });
  assert.equal(controller.state.hasUsedHeap, true, 'freeing the object does not erase historical heap use');

  controller.previous();
  controller.previous();
  assert.equal(controller.state.lifecycle.eventCount, 2, 'the selected point is before the heap event');
  assert.equal(controller.state.hasUsedHeap, true, 'Back does not reset the session signal');

  controller.start();
  assert.equal(controller.state.hasUsedHeap, false, 'a new session resets the signal');
  ready(workers[1]);
  assert.equal(controller.state.hasUsedHeap, false, 'a new session without heap remains false');
});

test('hasUsedHeap detects an allocation in the initial preparation events', () => {
  const { controller, workers } = setup();
  ready(workers[0], 1, [objectLifecycleEvent(1, 'object-create', 'heap')]);
  assert.equal(controller.state.hasUsedHeap, true);
});

test('Play waits 500 ms, prevents overlap, and stops on Back', () => {
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
  assert.equal(worker.messages.length, 2, 'steps do not queue while the Worker is unresponsive');
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
  assert.equal(controller.state.location.line, 1, 'the pending response remains in the history future');
  assert.equal(controller.state.canNext, true);
  timers.advance(1_000);
  assert.equal(worker.messages.length, 3, 'Back cancels pending ticks');
  controller.next();
  controller.next();
  assert.equal(controller.state.location.line, 3);
  assert.equal(worker.messages.length, 3, 'history future is traversed without advancing the VM again');
});

test('history and events respect the limit, and dispose cancels timers and Worker', () => {
  const { controller, workers, timers } = setup({ maxHistoryEntries: 2 });
  const worker = workers[0];
  const jobId = ready(worker, 1, [lifecycleEvent(1)]);
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [lifecycleEvent(2)] });
  controller.next();
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [lifecycleEvent(3)] });
  assert.equal(controller.state.stepIndex, 2);
  assert.equal(controller.state.lifecycle.eventCount, 3, 'lifecycle events retain the prefix after old locations are pruned');
  assert.equal(controller.state.historyNotice, 2);
  assert.equal(controller.state.canPrevious, true);

  controller.previous();
  assert.equal(controller.state.stepIndex, 1);
  assert.equal(controller.state.canPrevious, false, 'the navigable start advances with the history limit');
  assert.equal(controller.state.lifecycle.eventCount, 2);
  assert.equal(controller.state.historyNotice, 2);
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

test('stale job IDs do not change state, and preparation reports diagnostics', () => {
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
    message: 'main.c:1:17: Missing closing } for block.',
  });
  assert.equal(controller.state.status, 'error');
  assert.equal(controller.state.errorMessage, 'main.c:1:17: Missing closing } for block.');
});

test('the watchdog covers preparation and steps, but not waits between ticks or actions', () => {
  const configuration = { ...RUN_CONFIGURATION, timeoutMs: 100 };
  const { controller, workers, timers } = setup({ configuration });
  const worker = workers[0];

  timers.advance(99);
  assert.equal(controller.state.status, 'starting');
  ready(worker, 1);
  timers.advance(10_000);
  assert.equal(controller.state.status, 'paused', 'time spent waiting for user input does not consume the watchdog');

  controller.next();
  timers.advance(99);
  assert.equal(controller.state.status, 'running');
  timers.advance(1);
  assert.equal(controller.state.status, 'error');
  assert.match(controller.state.errorMessage, /The Memory Viewer exceeded its 100 ms time limit/u);
  assert.equal(worker.terminated, true);

  const preparing = setup({ configuration });
  preparing.timers.advance(100);
  assert.equal(preparing.controller.state.status, 'error');
  assert.equal(preparing.workers[0].terminated, true);
});

test('I/O off responds with EOF to the first input-needed without recording console history', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  controller.setConsoleEnabled(false);
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
  assert.equal(controller.state.stepIndex, 0, 'EOF continues the same step without creating history');
  assert.deepEqual(controller.state.transcript, [], 'automatic EOF is not recorded while console capture is off');
  assert.equal(controller.sendStdinLine('9'), false);

  const messageCount = worker.messages.length;
  controller.setConsoleEnabled(true);
  assert.equal(worker.messages.length, messageCount + 1, 'reactivating I/O updates capture without reopening stdin');
  assert.equal(worker.messages.at(-1).type, 'debug-console-enabled');
  assert.equal(worker.messages.at(-1).enabled, true);
  assert.equal(controller.sendStdinLine('9'), false, 'EOF remains closed after I/O is reactivated');
});

test('I/O off closes the wait from history without moving its cursor', () => {
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
  assert.equal(controller.state.inputRequestId, null, 'the stdin form is hidden in history');

  controller.setConsoleEnabled(false);
  assert.deepEqual(worker.messages.at(-1), {
    type: 'debug-stdin-eof', jobId, requestId: 2, inputRequestId: 13,
  });
  assert.equal(controller.state.stepIndex, 0);
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.isViewingHistory, true);

  const messageCount = worker.messages.length;
  controller.setConsoleEnabled(true);
  assert.equal(controller.sendStdinLine('ignored'), false, 'the internal token is already closed');
  assert.equal(worker.messages.length, messageCount + 1, 'I/O capture is enabled without restarting the session');

  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: terminated(), events: [] });
  assert.equal(controller.state.stepIndex, 0, 'the pending step response retains the history cursor');
  assert.equal(controller.state.location.line, 1);
  assert.equal(controller.state.isViewingHistory, true);
});

test('I/O on retains normal interactive input', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  controller.setConsoleEnabled(true);
  controller.next();
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 21, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });

  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 21);
  assert.equal(worker.messages.length, 2, 'EOF is not sent while I/O is on');
  assert.equal(controller.sendStdinLine('5'), true);
  assert.deepEqual(worker.messages.at(-1), {
    type: 'debug-stdin', jobId, requestId: 1, inputRequestId: 21,
    bytes: new TextEncoder().encode('5\n'),
  });
});

test('stdin retains the same step across waits while history restores the transcript prefix', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  controller.next();
  const step = worker.messages[1];

  worker.emit({ type: 'debug-output', jobId, requestId: step.requestId, sequence: 1, stream: 'stdout', chunk: new TextEncoder().encode('prompt> ') });
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'prompt> ', 'output appears before the first wait');
  worker.emit({ type: 'debug-output', jobId, requestId: 99, sequence: 2, stream: 'stdout', chunk: new TextEncoder().encode('stale') });
  worker.emit({
    type: 'debug-progress', jobId, requestId: step.requestId, inputRequestId: 1,
    progress: inputNeeded(2), events: [objectLifecycleEvent(2, 'object-create', 'heap')],
    heapObjects: [heapSnapshot(1, '0x1000')], pointers: [], arrays: [], omittedArrayObjects: 0,
    aggregates: [], omittedAggregateObjects: 0, stackScalars: [], staticObjects: [],
  });
  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 1);
  assert.equal(controller.state.stepIndex, 0, 'the wait does not create a history location');
  assert.equal(controller.state.lifecycle.eventCount, 1, 'transient events are retained once');
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
  assert.equal(controller.state.inputRequestId, 2, 'each actual input wait receives a new token');
  assert.equal(controller.state.stepIndex, 0, 'the second wait still does not add history');
  assert.equal(controller.state.stackScalars[0].displayValue, '12', 'the conversion assigned before the second wait is shown');
  assert.equal(controller.state.lifecycle.eventCount, 2);
  assert.equal(controller.sendStdinLine('34'), true);
  assert.equal(worker.messages.at(-1).requestId, step.requestId, 'the continuation reuses the request for the same step');
  assert.equal(worker.messages.at(-1).inputRequestId, 2);

  worker.emit({ type: 'debug-output', jobId, requestId: step.requestId, sequence: 3, stream: 'stdout', chunk: new TextEncoder().encode('34\n') });
  worker.emit({
    type: 'debug-progress', jobId, requestId: step.requestId, progress: paused(3), events: [objectLifecycleEvent(4, 'object-delete', 'heap')],
    heapObjects: [heapSnapshot(1, '0x1000')], pointers: [], arrays: [], omittedArrayObjects: 0,
    aggregates: [], omittedAggregateObjects: 0, stackScalars: [scalarSnapshot({ displayValue: '46' })], staticObjects: [],
  });
  assert.equal(controller.state.status, 'paused');
  assert.equal(controller.state.stepIndex, 1, 'the pending request creates a single entry when pausing');
  assert.equal(controller.state.inputRequestId, null);
  assert.equal(controller.state.lifecycle.eventCount, 3, 'events from both waits and the pause are added without being lost');
  assert.equal(controller.state.heapObjects.length, 1, 'final snapshots replace transient state');

  const outputText = controller.state.transcript.map(entry => entry.text).join('');
  assert.equal(outputText, 'prompt> 12\npart 12 34\n34\n');
  const messageCount = worker.messages.length;
  controller.previous();
  assert.equal(controller.state.isViewingHistory, true);
  assert.equal(controller.state.inputRequestId, null);
  assert.equal(controller.state.canStop, true, 'Stop remains available while traversing history as the VM runs');
  assert.deepEqual(controller.state.transcript, [], 'Back restores the console prefix captured before the pending step');
  controller.next();
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), outputText, 'Next restores already-recorded output and input');
  assert.equal(worker.messages.length, messageCount);
});

test('history checkpoints preserve ordered output and split ANSI sequences without future leakage', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  const presentation = new TerminalPresentation();
  const screen = () => presentation.update(formatConsoleSegments({
    status: 'running', transcript: controller.state.transcript, inputRequestId: null,
  }));

  controller.next();
  worker.emit({
    type: 'debug-output', jobId, requestId: 1, sequence: 1, stream: 'stdout',
    chunk: new TextEncoder().encode('before\n\u001b['),
  });
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [] });
  assert.equal(screen().screen.map(segment => segment.text).join(''), 'before\n');

  controller.next();
  worker.emit({
    type: 'debug-output', jobId, requestId: 2, sequence: 2, stream: 'stdout',
    chunk: new TextEncoder().encode('2J\u001b[Hfuture'),
  });
  worker.emit({
    type: 'debug-output', jobId, requestId: 2, sequence: 3, stream: 'stderr',
    chunk: new TextEncoder().encode('warning'),
  });
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [] });
  assert.equal(screen().screen.map(segment => segment.text).join(''), 'futurewarning');
  assert.deepEqual(controller.state.transcript.map(({ stream }) => stream), ['stdout', 'stderr']);

  const messageCount = worker.messages.length;
  controller.previous();
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'before\n\u001b[', 'the prior checkpoint truncates the coalesced stdout tail');
  assert.equal(screen().screen.map(segment => segment.text).join(''), 'before\n', 'Back resets and replays the partial CSI prefix');
  controller.next();
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'before\n\u001b[2J\u001b[Hfuturewarning');
  assert.equal(screen().screen.map(segment => segment.text).join(''), 'futurewarning', 'Next replays the selected prefix through clear-screen');
  assert.equal(worker.messages.length, messageCount, 'history navigation does not send another VM step');
});

test('console capture disabled at start skips deltas and enabling later does not recover old output', () => {
  const { controller, workers } = setup({ enableConsole: false });
  const worker = workers[0];
  const jobId = ready(worker, 1);
  assert.equal(worker.messages[0].enableConsole, false);

  controller.next();
  worker.emit({
    type: 'debug-output', jobId, requestId: 1, sequence: 1, stream: 'stdout',
    consoleGeneration: 0, chunk: new TextEncoder().encode('hidden'),
  });
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 5, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });
  assert.equal(worker.messages.at(-1).type, 'debug-stdin-eof', 'stdin still receives EOF while capture is off');
  assert.deepEqual(controller.state.transcript, []);

  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: terminated(), events: [] });
  controller.setConsoleEnabled(true);
  assert.deepEqual(controller.state.transcript, [], 'turning capture on after termination cannot replay discarded output');
});

test('console generation rejects output already queued when capture is toggled off and back on', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  controller.next();
  controller.setConsoleEnabled(false);
  controller.setConsoleEnabled(true);

  worker.emit({
    type: 'debug-output', jobId, requestId: 1, sequence: 1, stream: 'stdout',
    consoleGeneration: 0, chunk: new TextEncoder().encode('discarded'),
  });
  worker.emit({
    type: 'debug-output', jobId, requestId: 1, sequence: 2, stream: 'stdout',
    consoleGeneration: 1, chunk: new TextEncoder().encode('also discarded'),
  });
  worker.emit({
    type: 'debug-output', jobId, requestId: 1, sequence: 3, stream: 'stdout',
    consoleGeneration: 2, chunk: new TextEncoder().encode('captured'),
  });
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(2), events: [] });
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'captured');
});

test('EOF uses the wait token once and Stop retains partial output and history', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker);
  controller.next();
  worker.emit({ type: 'debug-output', jobId, requestId: 1, sequence: 1, stream: 'stderr', chunk: new TextEncoder().encode('partial diagnostic') });
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
  assert.ok(controller.state.transcript.some(entry => entry.text === 'partial diagnostic'));
  const transcript = controller.state.transcript;
  worker.emit({ type: 'debug-output', jobId, requestId: 1, sequence: 2, stream: 'stderr', chunk: new TextEncoder().encode('late') });
  assert.equal(controller.state.transcript, transcript, 'late output after Stop is discarded');
  assert.equal(controller.sendStdinEOF(), false);
});

test('EOF echo appears at the live frontier and is restored only at its saved history point', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  controller.next();
  worker.emit({
    type: 'debug-output', jobId, requestId: 1, sequence: 1, stream: 'stdout',
    chunk: new TextEncoder().encode('prompt> '),
  });
  worker.emit({
    type: 'debug-progress', jobId, requestId: 1, inputRequestId: 8, progress: inputNeeded(2), events: [],
    heapObjects: [], pointers: [], arrays: [], omittedArrayObjects: 0, aggregates: [], omittedAggregateObjects: 0,
    stackScalars: [], staticObjects: [],
  });
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'prompt> ');
  assert.equal(controller.sendStdinEOF(), true);
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'prompt> [EOF]\n');
  worker.emit({ type: 'debug-progress', jobId, requestId: 1, progress: paused(3), events: [] });

  const messageCount = worker.messages.length;
  controller.previous();
  assert.deepEqual(controller.state.transcript, [], 'Back hides the later prompt and EOF echo');
  controller.next();
  assert.equal(controller.state.transcript.map(entry => entry.text).join(''), 'prompt> [EOF]\n');
  assert.equal(worker.messages.length, messageCount, 'restoring an EOF checkpoint does not resend EOF or input');
});

test('a stdin wait is hidden in old history and reappears when returning to its boundary', () => {
  const { controller, workers } = setup();
  const worker = workers[0];
  const jobId = ready(worker, 1);
  assert.equal(controller.state.canStop, true, 'Stop remains available while the paused VM is alive');
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
  assert.equal(controller.state.inputRequestId, null, 'the live VM form is not projected into the past');
  assert.equal(controller.sendStdinLine('invalid'), false);
  assert.equal(controller.state.canStop, true);

  controller.next();
  assert.equal(controller.state.status, 'waiting-input');
  assert.equal(controller.state.inputRequestId, 13, 'the same request reappears when returning to the frontier');
  assert.equal(worker.messages.length, 3, 'traversing cached future does not send another debug-step');
  assert.equal(controller.sendStdinLine('5'), true);
  worker.emit({ type: 'debug-progress', jobId, requestId: 2, progress: paused(3), events: [] });
  assert.equal(controller.state.status, 'paused');
  controller.previous();
  assert.equal(controller.state.canStop, true, 'the paused VM can still be cancelled from any visible step');
});

test('the watchdog pauses during the wait and resumes when stdin is sent', () => {
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
