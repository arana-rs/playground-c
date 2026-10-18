import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';
import { findMemoryViewerChangedArrayElementKeys } from '../src/memory/arraySnapshots.ts';
import {
  findMemoryViewerChangedPointerIds,
  resolveMemoryViewerPointerTarget,
  resolveMemoryViewerPointerTargetId,
} from '../src/memory/pointerSnapshots.ts';

const pointerExampleSource = readFileSync(new URL('./fixtures/memory-viewer-pointers.c', import.meta.url), 'utf8');
const arrayPointerExampleSource = readFileSync(new URL('./fixtures/memory-viewer-pointer-arrays.c', import.meta.url), 'utf8');

function pointerSnapshot(id, name, displayValue, status, target, type = 'int *') {
  return {
    id,
    scopeId: 2,
    frameId: 1,
    name,
    origin: 'variable',
    duration: 'automatic',
    region: 'stack',
    type,
    address: `0x${(0x20000 + id * 0x10).toString(16)}`,
    size: 8,
    initialized: status !== 'uninitialized',
    displayValue,
    status,
    ...(target ? { target: { ...target } } : {}),
  };
}

function arraySnapshot(rootId, name, values, {
  address = `0x${(0x10000 + rootId * 0x100).toString(16)}`,
  elementType = 'int',
  elementSize = elementType === 'char' ? 1 : 4,
  region = 'stack',
  status = 'available',
} = {}) {
  const baseAddress = BigInt(address);
  return {
    rootId,
    name,
    origin: 'variable',
    duration: region === 'stack' ? 'automatic' : 'static',
    region,
    frameId: region === 'stack' ? 1 : null,
    scopeId: region === 'stack' ? 2 : null,
    type: `${elementType}[${values.length}]`,
    elementType,
    address,
    size: values.length * elementSize,
    length: values.length,
    readOnly: false,
    status,
    elements: status === 'available' ? values.map((displayValue, index) => ({
      key: `${rootId}:${index}`,
      index,
      address: `0x${(baseAddress + BigInt(index * elementSize)).toString(16)}`,
      type: elementType,
      initialized: true,
      displayValue,
      valueTruncated: false,
    })) : [],
  };
}

function scalarSnapshot(id, name, displayValue) {
  return {
    id,
    scopeId: 2,
    frameId: 1,
    name,
    type: 'int',
    address: `0x${(0x20000 + id * 0x10).toString(16)}`,
    size: 4,
    initialized: true,
    displayValue,
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

function setupController(source = pointerExampleSource) {
  const workers = [];
  const controller = new MemoryViewerController(source, {
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

test('the Worker runs the pointer example and separates its address, value, and target', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-pointer-example-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 301, fileName: 'main.c', source: pointerExampleSource,
    } });
    assert.equal(responses[0].type, 'debug-ready');
    assert.ok(Array.isArray(responses[0].pointers));

    let terminal;
    for (let requestId = 1; requestId <= 12; requestId += 1) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 301, requestId } });
      const response = responses.at(-1);
      assert.equal(response.type, 'debug-progress');
      assert.ok(Array.isArray(response.pointers));
      if (response.progress.kind !== 'paused') {
        terminal = response;
        break;
      }
    }

    assert.ok(terminal, 'the example reaches a terminal state');
    assert.equal(terminal.progress.kind, 'terminated', JSON.stringify(terminal.progress));
    assert.equal(terminal.progress.mainReturn, 0);
    assert.equal(terminal.progress.exitCode, 0);

    const steps = responses.slice(0, -1);
    const observed = name => steps
      .map(response => ({
        pointer: response.pointers.find(item => item.name === name),
        scalars: [...response.stackScalars, ...response.staticObjects],
      }))
      .filter(({ pointer }) => pointer);
    const pending = observed('uninitialized');
    assert.ok(pending.some(({ pointer }) =>
      pointer.status === 'uninitialized' && !pointer.initialized && pointer.displayValue === '?' && pointer.target === undefined,
    ));

    const pSteps = observed('p');
    assert.ok(pSteps.length >= 5, 'p remains inspectable across its assignments');
    const ownId = pSteps[0].pointer.id;
    const ownAddress = pSteps[0].pointer.address;
    assert.ok(pSteps.every(({ pointer }) => pointer.id === ownId && pointer.address === ownAddress));

    const pointsToN = pSteps.find(({ pointer, scalars }) =>
      pointer.status === 'live' && scalars.some(scalar => scalar.name === 'n' && pointer.target?.allocationId === scalar.id),
    );
    assert.ok(pointsToN, 'p points to object n by its allocation ID');
    const n = pointsToN.scalars.find(scalar => scalar.name === 'n');
    assert.notEqual(pointsToN.pointer.address, n.address, 'address represents pointer p itself');
    assert.equal(pointsToN.pointer.displayValue, n.address, 'displayValue represents the address stored in p');
    assert.deepEqual(
      { allocationId: pointsToN.pointer.target.allocationId, byteOffset: pointsToN.pointer.target.byteOffset },
      { allocationId: n.id, byteOffset: 0 },
    );

    const afterIndirectWrite = pSteps.find(({ pointer, scalars }) =>
      pointer.target?.allocationId === n.id && scalars.find(scalar => scalar.name === 'n')?.displayValue === '20',
    );
    assert.ok(afterIndirectWrite, '*p = 20 modifies n');
    assert.equal(afterIndirectWrite.pointer.displayValue, pointsToN.pointer.displayValue);
    assert.equal(afterIndirectWrite.pointer.target.allocationId, pointsToN.pointer.target.allocationId);

    const pointsToOther = pSteps.find(({ pointer, scalars }) =>
      pointer.status === 'live' && scalars.some(scalar => scalar.name === 'other' && pointer.target?.allocationId === scalar.id),
    );
    assert.ok(pointsToOther, 'p can change its target to other');
    const other = pointsToOther.scalars.find(scalar => scalar.name === 'other');
    assert.equal(pointsToOther.pointer.displayValue, other.address);
    assert.notEqual(pointsToOther.pointer.target.allocationId, pointsToN.pointer.target.allocationId);

    const afterSecondIndirectWrite = pSteps.find(({ pointer, scalars }) =>
      pointer.target?.allocationId === other.id && scalars.find(scalar => scalar.name === 'other')?.displayValue === '40',
    );
    assert.ok(afterSecondIndirectWrite, '*p = 40 modifies other');
    assert.equal(afterSecondIndirectWrite.pointer.address, ownAddress);
    assert.equal(afterSecondIndirectWrite.pointer.displayValue, pointsToOther.pointer.displayValue);

    const nulled = pSteps.find(({ pointer }) => pointer.status === 'null');
    assert.ok(nulled);
    assert.equal(nulled.pointer.displayValue, '0x0');
    assert.equal(nulled.pointer.target, undefined);
    assert.equal(nulled.pointer.id, ownId);
    assert.equal(nulled.pointer.address, ownAddress);
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the Worker links pointer arithmetic to array cells and follows a string to NUL', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-array-pointer-worker-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 302, fileName: 'main.c', source: arrayPointerExampleSource,
    } });
    assert.equal(responses[0].type, 'debug-ready');
    assert.ok(Array.isArray(responses[0].pointers));
    assert.ok(Array.isArray(responses[0].arrays));

    let terminal;
    for (let requestId = 1; requestId <= 32; requestId += 1) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 302, requestId } });
      const response = responses.at(-1);
      assert.equal(response.type, 'debug-progress');
      assert.ok(Array.isArray(response.pointers));
      assert.ok(Array.isArray(response.arrays));
      if (response.progress.kind !== 'paused') {
        terminal = response;
        break;
      }
    }

    assert.ok(terminal, 'the example reaches a terminal state');
    assert.equal(terminal.progress.kind, 'terminated', JSON.stringify(terminal.progress));
    assert.equal(terminal.progress.mainReturn, 0);
    assert.equal(terminal.progress.exitCode, 0);

    const steps = responses.filter(response => response.type === 'debug-progress' && response.progress.kind === 'paused');
    const observed = name => steps.map(response => ({
      response,
      pointer: response.pointers.find(item => item.name === name),
      array: response.arrays.find(item => item.name === (name === 'p' ? 'a' : 'text')),
    })).filter(({ pointer, array }) => pointer && array);

    const pSteps = observed('p');
    const pAtFirstCell = pSteps.find(({ pointer }) => pointer.target?.byteOffset === 0);
    const pAfterIncrement = pSteps.find(({ pointer, array }) =>
      pointer.target?.byteOffset === 4 && array.elements[1]?.displayValue === '20',
    );
    const pAfterWrite = pSteps.find(({ pointer, array }) =>
      pointer.target?.byteOffset === 4 && array.elements[1]?.displayValue === '99',
    );
    assert.ok(pAtFirstCell && pAfterIncrement && pAfterWrite, 'p points to the first cell, advances, and writes to the next one');
    const pId = pAtFirstCell.pointer.id;
    const pAddress = pAtFirstCell.pointer.address;
    assert.ok(pSteps.every(({ pointer }) => pointer.id === pId && pointer.address === pAddress));
    assert.equal(pAtFirstCell.pointer.displayValue, pAtFirstCell.array.elements[0].address);
    assert.deepEqual(
      resolveMemoryViewerPointerTarget(pId, pAtFirstCell.response.pointers, pAtFirstCell.response.stackScalars, pAtFirstCell.response.arrays),
      { kind: 'array-cell', allocationId: pAtFirstCell.array.rootId, elementKey: `${pAtFirstCell.array.rootId}:0`, index: 0, region: 'stack' },
    );
    assert.equal(pAfterIncrement.pointer.target.allocationId, pAfterIncrement.array.rootId);
    assert.equal(pAfterIncrement.pointer.displayValue, pAfterIncrement.array.elements[1].address);
    assert.deepEqual(
      resolveMemoryViewerPointerTarget(pId, pAfterIncrement.response.pointers, pAfterIncrement.response.stackScalars, pAfterIncrement.response.arrays),
      { kind: 'array-cell', allocationId: pAfterIncrement.array.rootId, elementKey: `${pAfterIncrement.array.rootId}:1`, index: 1, region: 'stack' },
    );
    assert.deepEqual(findMemoryViewerChangedPointerIds(pAtFirstCell.response.pointers, pAfterIncrement.response.pointers), [pId],
      'p++ changes the address stored in the pointer');
    assert.deepEqual(findMemoryViewerChangedArrayElementKeys(pAtFirstCell.response.arrays, pAfterIncrement.response.arrays), [],
      'p++ does not modify the array');
    assert.deepEqual(findMemoryViewerChangedArrayElementKeys(pAfterIncrement.response.arrays, pAfterWrite.response.arrays), [`${pAfterWrite.array.rootId}:1`],
      '*p marks the change only on the written cell');
    assert.deepEqual(findMemoryViewerChangedPointerIds(pAfterIncrement.response.pointers, pAfterWrite.response.pointers), [],
      '*p does not change the pointer snapshot');

    const qSteps = observed('q');
    assert.deepEqual(qSteps.map(({ pointer }) => pointer.target?.byteOffset), [0, 1, 2, 3, 4],
      'q visits each character and reaches the NUL terminator');
    const qAtNul = qSteps.at(-1);
    assert.equal(qAtNul.array.elements.length, 5);
    assert.equal(qAtNul.array.elements[4].displayValue, "'\\0'");
    assert.equal(qAtNul.pointer.displayValue, qAtNul.array.elements[4].address);
    assert.deepEqual(
      resolveMemoryViewerPointerTarget(qAtNul.pointer.id, qAtNul.response.pointers, qAtNul.response.stackScalars, qAtNul.response.arrays),
      { kind: 'array-cell', allocationId: qAtNul.array.rootId, elementKey: `${qAtNul.array.rootId}:4`, index: 4, region: 'stack' },
    );
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('history retains the selected cell target and rejects stale requests and jobs', () => {
  const { controller, workers } = setupController(arrayPointerExampleSource);
  const firstWorker = workers[0];
  const firstJobId = firstWorker.messages[0].jobId;
  const firstArray = arraySnapshot(17, 'a', ['10', '20', '30']);
  const firstPointer = pointerSnapshot(20, 'p', firstArray.elements[0].address, 'live', {
    allocationId: firstArray.rootId, byteOffset: 0, type: 'int', name: 'a',
  });

  firstWorker.emit({
    type: 'debug-ready', jobId: firstJobId,
    location: { file: 'main.c', line: 4, column: 1 },
    events: [], heapObjects: [], arrays: [firstArray], omittedArrayObjects: 0,
    stackScalars: [], staticObjects: [], pointers: [firstPointer],
  });
  const originalPointer = controller.state.pointers.find(pointer => pointer.name === 'p');
  assert.equal(originalPointer.displayValue, firstArray.elements[0].address);
  assert.ok(Object.isFrozen(controller.state.pointers));
  assert.ok(Object.isFrozen(originalPointer));
  assert.ok(Object.isFrozen(originalPointer.target));
  assert.ok(Object.isFrozen(controller.state.arrays[0].elements));
  firstArray.elements[0].displayValue = 'external mutation';
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '10', 'the Worker does not retain access to the historical array');

  controller.next();
  const firstRequestId = firstWorker.messages.at(-1).requestId;
  const incrementedArray = arraySnapshot(17, 'a', ['10', '20', '30']);
  const incrementedPointer = pointerSnapshot(20, 'p', incrementedArray.elements[1].address, 'live', {
    allocationId: incrementedArray.rootId, byteOffset: 4, type: 'int', name: 'a',
  });
  firstWorker.emit({
    type: 'debug-progress', jobId: firstJobId, requestId: firstRequestId + 1,
    progress: { kind: 'paused', location: { file: 'main.c', line: 5, column: 1 }, metrics: {} },
    events: [], heapObjects: [], arrays: [incrementedArray], omittedArrayObjects: 0,
    stackScalars: [], staticObjects: [], pointers: [incrementedPointer],
  });
  assert.equal(controller.state.pointers.find(pointer => pointer.name === 'p').target.byteOffset, 0,
    'a stale requestId does not change the selected target');

  firstWorker.emit({
    type: 'debug-progress', jobId: firstJobId, requestId: firstRequestId,
    progress: { kind: 'paused', location: { file: 'main.c', line: 5, column: 1 }, metrics: {} },
    events: [], heapObjects: [], arrays: [incrementedArray], omittedArrayObjects: 0,
    stackScalars: [], staticObjects: [], pointers: [incrementedPointer],
  });
  const savedIncrementedPointer = controller.state.pointers.find(pointer => pointer.name === 'p');
  incrementedPointer.target.byteOffset = 999;
  incrementedPointer.displayValue = 'value mutated outside history';
  assert.equal(savedIncrementedPointer.target.byteOffset, 4);
  assert.equal(savedIncrementedPointer.displayValue, incrementedArray.elements[1].address);

  controller.next();
  const writeRequestId = firstWorker.messages.at(-1).requestId;
  const writtenArray = arraySnapshot(17, 'a', ['10', '99', '30']);
  const writtenPointer = pointerSnapshot(20, 'p', writtenArray.elements[1].address, 'live', {
    allocationId: writtenArray.rootId, byteOffset: 4, type: 'int', name: 'a',
  });
  firstWorker.emit({
    type: 'debug-progress', jobId: firstJobId, requestId: writeRequestId,
    progress: { kind: 'paused', location: { file: 'main.c', line: 6, column: 1 }, metrics: {} },
    events: [], heapObjects: [], arrays: [writtenArray], omittedArrayObjects: 0,
    stackScalars: [], staticObjects: [], pointers: [writtenPointer],
  });
  assert.deepEqual(findMemoryViewerChangedPointerIds([savedIncrementedPointer], [writtenPointer]), [],
    '*p retains the address value stored by the pointer');
  assert.deepEqual(findMemoryViewerChangedArrayElementKeys([incrementedArray], [writtenArray]), ['17:1']);

  const messageCount = firstWorker.messages.length;
  controller.previous();
  assert.equal(controller.state.pointers.find(pointer => pointer.name === 'p').target.byteOffset, 4);
  assert.equal(controller.state.arrays[0].elements[1].displayValue, '20');
  controller.next();
  assert.equal(controller.state.pointers.find(pointer => pointer.name === 'p').target.byteOffset, 4);
  assert.equal(controller.state.arrays[0].elements[1].displayValue, '99');
  assert.equal(firstWorker.messages.length, messageCount, 'Back/Next restores snapshots without advancing the VM again');
  assert.equal(originalPointer.target.byteOffset, 0, 'navigation does not modify the previous state');

  const replacementSource = 'int main(void) { int a[1] = {77}; return 0; }';
  controller.start(replacementSource);
  const replacementWorker = workers[1];
  const replacementJobId = replacementWorker.messages[0].jobId;
  const replacementArray = arraySnapshot(17, 'a', ['77']);
  const replacementPointer = pointerSnapshot(20, 'p', replacementArray.elements[0].address, 'live', {
    allocationId: replacementArray.rootId, byteOffset: 0, type: 'int', name: 'a',
  });
  replacementWorker.emit({
    type: 'debug-ready', jobId: replacementJobId,
    location: { file: 'main.c', line: 1, column: 1 },
    events: [], heapObjects: [], arrays: [replacementArray], omittedArrayObjects: 0,
    stackScalars: [], staticObjects: [], pointers: [replacementPointer],
  });
  assert.equal(controller.state.source, replacementSource);
  assert.equal(controller.state.stepIndex, 0);
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '77');

  firstWorker.emit({
    type: 'debug-progress', jobId: firstJobId, requestId: writeRequestId + 1,
    progress: { kind: 'paused', location: { file: 'main.c', line: 1, column: 1 }, metrics: {} },
    events: [], heapObjects: [], arrays: [arraySnapshot(17, 'a', ['999'])], omittedArrayObjects: 0,
    stackScalars: [], staticObjects: [],
    pointers: [pointerSnapshot(20, 'p', '0x0000000000011104', 'live', {
      allocationId: 17, byteOffset: 4, type: 'int', name: 'a',
    })],
  });
  assert.equal(controller.state.arrays[0].elements[0].displayValue, '77', 'an earlier job does not contaminate current values');
  assert.deepEqual(
    resolveMemoryViewerPointerTarget(20, controller.state.pointers, controller.state.stackScalars, controller.state.arrays),
    { kind: 'array-cell', allocationId: 17, elementKey: '17:0', index: 0, region: 'stack' },
    'the reused ID resolves only the pointer and array from the selected job',
  );
  controller.dispose();
});

test('cell resolution uses identity, exact integer offset, type, and visible cells', () => {
  const array = arraySnapshot(50, 'wide', ['10', '20', '30'], { address: '0x10000000000000001' });
  const atSecondCell = pointerSnapshot(80, 'p', array.elements[1].address, 'live', {
    allocationId: array.rootId, byteOffset: 4, type: 'int', name: 'wide',
  });
  assert.deepEqual(
    resolveMemoryViewerPointerTarget(80, [atSecondCell], [], [array]),
    { kind: 'array-cell', allocationId: 50, elementKey: '50:1', index: 1, region: 'stack' },
    'addresses above 2^53 retain their exact offset through BigInt',
  );

  const sameAddressDifferentAllocation = arraySnapshot(51, 'replacement', ['10', '20', '30'], {
    address: array.address,
  });
  assert.equal(resolveMemoryViewerPointerTarget(80, [atSecondCell], [], [sameAddressDifferentAllocation]), null,
    'the same address with another allocationId does not link the cell');

  const misaligned = pointerSnapshot(80, 'p', `0x${(BigInt(array.address) + 2n).toString(16)}`, 'live', {
    allocationId: array.rootId, byteOffset: 2, type: 'int',
  });
  assert.equal(resolveMemoryViewerPointerTarget(80, [misaligned], [], [array]), null,
    'an offset between cells does not produce a link');

  const wrongType = pointerSnapshot(80, 'p', array.elements[1].address, 'live', {
    allocationId: array.rootId, byteOffset: 4, type: 'unsigned int',
  }, 'unsigned int *');
  assert.equal(resolveMemoryViewerPointerTarget(80, [wrongType], [], [array]), null,
    'identity and offset are insufficient when the designated type differs');

  const onePast = pointerSnapshot(80, 'p', `0x${(BigInt(array.address) + 12n).toString(16)}`, 'one-past', {
    allocationId: array.rootId, byteOffset: 12, type: 'int',
  });
  assert.equal(resolveMemoryViewerPointerTarget(80, [onePast], [], [array]), null,
    'one-past does not match any existing cell');

  const dangling = pointerSnapshot(80, 'p', array.elements[1].address, 'dangling', {
    allocationId: array.rootId, byteOffset: 4, type: 'int',
  });
  assert.equal(resolveMemoryViewerPointerTarget(80, [dangling], [], [array]), null,
    'a dead allocation is not linked again even if its ID matches');

  const tooLarge = arraySnapshot(52, 'large', Array(11).fill('?'), { status: 'too-many-elements' });
  const pointerToLarge = pointerSnapshot(81, 'large_pointer', tooLarge.address, 'live', {
    allocationId: tooLarge.rootId, byteOffset: 0, type: 'int', name: 'large',
  });
  assert.equal(tooLarge.elements.length, 0);
  assert.equal(resolveMemoryViewerPointerTarget(81, [pointerToLarge], [], [tooLarge]), null,
    'an array with only a local placeholder does not link to a nonexistent cell');

  const matrix = {
    ...arraySnapshot(53, 'matrix', [], { status: 'multidimensional' }),
    type: 'int[2][2]',
    elementType: 'int[2]',
    length: 2,
    size: 16,
  };
  const pointerToMatrix = pointerSnapshot(82, 'matrix_pointer', matrix.address, 'live', {
    allocationId: matrix.rootId, byteOffset: 0, type: 'int', name: 'matrix',
  });
  assert.equal(resolveMemoryViewerPointerTarget(82, [pointerToMatrix], [], [matrix]), null,
    'a matrix retains its placeholder and does not expose its subcells as scalars');
});

test('scalar highlighting retains root identity and rejects invalid targets', () => {
  const scalar = scalarSnapshot(10, 'n', '20');
  const livePointer = pointerSnapshot(20, 'p', scalar.address, 'live', {
    allocationId: scalar.id, byteOffset: 0, type: 'int', name: 'n',
  });
  assert.equal(resolveMemoryViewerPointerTargetId(20, [livePointer], [scalar]), scalar.id);

  const missingTarget = pointerSnapshot(20, 'p', '0x2aaaa', 'live', {
    allocationId: 999, byteOffset: 0, type: 'int', name: 'n',
  });
  assert.equal(resolveMemoryViewerPointerTargetId(20, [missingTarget], [scalar]), null,
    'an allocation that is no longer live is not highlighted');

  const interiorPointer = pointerSnapshot(20, 'p', '0x20004', 'live', {
    allocationId: scalar.id, byteOffset: 4, type: 'int', name: 'n',
  });
  assert.equal(resolveMemoryViewerPointerTargetId(20, [interiorPointer], [scalar]), null,
    'an interior offset is not resolved as a scalar root');

  const danglingPointer = pointerSnapshot(20, 'p', scalar.address, 'dangling', {
    allocationId: scalar.id, byteOffset: 0, type: 'int', name: 'n',
  });
  assert.equal(resolveMemoryViewerPointerTargetId(20, [danglingPointer], [scalar]), null,
    'a dangling pointer does not highlight a matching address');
  assert.equal(resolveMemoryViewerPointerTargetId(999, [livePointer], [scalar]), null);
});
