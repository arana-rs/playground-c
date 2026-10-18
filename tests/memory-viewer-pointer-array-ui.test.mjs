import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';
import {
  findMemoryViewerChangedArrayElementKeys,
} from '../src/memory/arraySnapshots.ts';
import {
  findMemoryViewerChangedPointerIds,
  memoryViewerArrayElementPointerIdentity,
  resolveMemoryViewerPointerTarget,
} from '../src/memory/pointerSnapshots.ts';
import { createServer } from 'vite';

function arraySnapshot(rootId, name, elementType, elements, {
  address = `0x${(0x10000 + rootId * 0x100).toString(16)}`,
  region = 'stack',
  status = 'available',
  size = elements.length * (elementType === 'int' ? 4 : 8),
  length = elements.length,
} = {}) {
  return {
    rootId,
    name,
    origin: 'variable',
    duration: region === 'stack' ? 'automatic' : 'static',
    region,
    frameId: region === 'stack' ? 1 : null,
    scopeId: region === 'stack' ? 2 : null,
    type: `${elementType}[${length}]`,
    elementType,
    address,
    size,
    length,
    readOnly: false,
    status,
    elements: elements.map((element, index) => ({
      key: `${rootId}:${index}`,
      index,
      address: `0x${(BigInt(address) + BigInt(index * (elementType === 'int' ? 4 : 8))).toString(16)}`,
      type: elementType,
      initialized: element.initialized,
      displayValue: element.displayValue,
      valueTruncated: false,
      ...(element.pointerStatus === undefined ? {} : {
        kind: 'pointer',
        pointerStatus: element.pointerStatus,
        ...(element.target ? { target: { ...element.target } } : {}),
      }),
    })),
  };
}

function pointerSnapshot(id, name, displayValue, target) {
  return {
    id,
    scopeId: 2,
    frameId: 1,
    name,
    origin: 'variable',
    duration: 'automatic',
    region: 'stack',
    type: 'int *',
    address: `0x${(0x20000 + id * 0x10).toString(16)}`,
    size: 8,
    initialized: true,
    displayValue,
    status: 'live',
    ...(target ? { target: { ...target } } : {}),
  };
}

function renderArray(ArrayBlock, LanguageProvider, array, pointerTargetElementKey = null) {
  return renderToStaticMarkup(createElement(LanguageProvider, { initialLanguage: 'en' },
    createElement(ArrayBlock, {
      array,
      changedElementKeys: new Set(),
      pointerTargetElementKey,
    })));
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

function readyResponse(jobId, arrays, pointers = []) {
  return {
    type: 'debug-ready',
    jobId,
    location: { file: 'main.c', line: 1, column: 1 },
    hasHeapAllocationCalls: false,
    events: [],
    heapObjects: [],
    arrays,
    omittedArrayObjects: 0,
    aggregates: [],
    omittedAggregateObjects: 0,
    stackScalars: [],
    staticObjects: [],
    pointers,
  };
}

function progressResponse(jobId, requestId, arrays, pointers = []) {
  return {
    type: 'debug-progress',
    jobId,
    requestId,
    progress: { kind: 'paused', location: { file: 'main.c', line: 2, column: 1 }, metrics: {} },
    events: [],
    heapObjects: [],
    arrays,
    omittedArrayObjects: 0,
    aggregates: [],
    omittedAggregateObjects: 0,
    stackScalars: [],
    staticObjects: [],
    pointers,
  };
}

test('pointer array cells retain their own address, pointer states, and a visible direct target', async () => {
  const target = arraySnapshot(31, 'values', 'int', [
    { initialized: true, displayValue: '10' },
    { initialized: true, displayValue: '20' },
  ]);
  const targetAddress = target.elements[1].address;
  const pointers = arraySnapshot(32, 'links', 'int *', [
    {
      initialized: true,
      displayValue: targetAddress,
      pointerStatus: 'live',
      target: { allocationId: target.rootId, byteOffset: 4, type: 'int', name: 'values' },
    },
    { initialized: true, displayValue: '0x0', pointerStatus: 'null' },
    { initialized: false, displayValue: '?', pointerStatus: 'uninitialized' },
    { initialized: true, displayValue: '0xdead', pointerStatus: 'unmapped' },
    {
      initialized: true,
      displayValue: '0x0000000000012004',
      pointerStatus: 'dangling',
      target: { allocationId: 999, byteOffset: 4, type: 'int' },
    },
  ]);
  const identity = memoryViewerArrayElementPointerIdentity(pointers.rootId, 0);
  const resolved = resolveMemoryViewerPointerTarget(identity, [], [], [pointers, target]);
  assert.deepEqual(resolved, {
    kind: 'array-cell',
    allocationId: target.rootId,
    elementKey: `${target.rootId}:1`,
    index: 1,
    region: 'stack',
  });
  assert.notEqual(pointers.elements[0].address, pointers.elements[0].displayValue,
    'an array element address describes pointer storage, while displayValue describes the address it stores');

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, ws: false },
  });
  try {
    const { MemoryViewerArrayBlock } = await vite.ssrLoadModule('/src/memory/MemoryViewer.tsx');
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const markup = renderArray(MemoryViewerArrayBlock, LanguageProvider, pointers);
    assert.equal((markup.match(/data-memory-viewer-array-element-key=/g) ?? []).length, 5,
      'the five pointer elements stay inside their parent array');
    assert.equal((markup.match(/data-memory-viewer-scalar-id=/g) ?? []).length, 1,
      'the array root appears once rather than creating duplicate Stack variables');
    assert.match(markup, /data-memory-viewer-array-element-key="32:0"[^>]*data-pointer-status="live"/);
    assert.match(markup, /data-memory-viewer-array-element-key="32:1"[^>]*data-pointer-status="null"/);
    assert.match(markup, /data-memory-viewer-array-element-key="32:2"[^>]*data-pointer-status="uninitialized"/);
    assert.match(markup, /data-memory-viewer-array-element-key="32:3"[^>]*data-pointer-status="unmapped"/);
    assert.match(markup, /data-memory-viewer-array-element-key="32:4"[^>]*data-pointer-status="dangling"/);
    assert.match(markup, /memory-viewer-scalar--pointer-null/);
    assert.match(markup, /memory-viewer-scalar--uninitialized/);
    assert.match(markup, /tabindex="0"/);
    assert.ok(markup.includes(pointers.elements[0].address), 'the pointer cell storage address is displayed');
    assert.ok(markup.includes(targetAddress), 'the stored target address is displayed as the pointer value');

    const targetMarkup = renderArray(
      MemoryViewerArrayBlock,
      LanguageProvider,
      target,
      resolved.kind === 'array-cell' ? resolved.elementKey : null,
    );
    assert.match(targetMarkup, /data-memory-viewer-array-element-key="31:1"[^>]*data-pointer-target="true"/,
      'a live pointer highlights its directly matched visible cell');

    const tooMany = arraySnapshot(33, 'too_many', 'int *', [], {
      length: 11,
      size: 88,
      status: 'too-many-elements',
    });
    const placeholderMarkup = renderArray(MemoryViewerArrayBlock, LanguageProvider, tooMany);
    assert.match(placeholderMarkup, /Maximum 10 elements/);
    assert.doesNotMatch(placeholderMarkup, /data-memory-viewer-array-element-key=/,
      'the array stays a placeholder beyond its ten-cell inspection limit');
  } finally {
    await vite.close();
  }
});

test('pointer cell initialization and mutation snapshots survive Memory Viewer history', () => {
  const { controller, workers } = setupController();
  const worker = workers[0];
  const jobId = worker.messages[0].jobId;
  const target = arraySnapshot(41, 'values', 'int', [
    { initialized: true, displayValue: '10' },
  ]);
  const initial = arraySnapshot(42, 'links', 'int *', [
    { initialized: false, displayValue: '?', pointerStatus: 'uninitialized' },
  ]);
  const standalone = pointerSnapshot(50, 'standalone', target.elements[0].address, {
    allocationId: target.rootId,
    byteOffset: 0,
    type: 'int',
    name: 'values',
  });
  worker.emit(readyResponse(jobId, [target, initial], [standalone]));

  const firstLink = controller.state.arrays.find(array => array.name === 'links');
  assert.equal(firstLink.elements[0].pointerStatus, 'uninitialized');
  assert.equal(firstLink.elements[0].address, initial.elements[0].address);
  assert.notEqual(firstLink.elements[0].address, firstLink.elements[0].displayValue);
  assert.ok(Object.isFrozen(firstLink.elements[0]));

  controller.next();
  const requestId = worker.messages.at(-1).requestId;
  const mutated = arraySnapshot(42, 'links', 'int *', [{
    initialized: true,
    displayValue: target.elements[0].address,
    pointerStatus: 'live',
    target: { allocationId: target.rootId, byteOffset: 0, type: 'int', name: 'values' },
  }]);
  worker.emit(progressResponse(jobId, requestId, [target, mutated], [standalone]));
  assert.deepEqual(findMemoryViewerChangedArrayElementKeys([initial], [mutated]), ['42:0']);
  assert.deepEqual(findMemoryViewerChangedPointerIds([standalone], [standalone]), [],
    'updating an array pointer does not alter standalone pointer snapshots');
  const liveLink = controller.state.arrays.find(array => array.name === 'links');
  assert.equal(liveLink.elements[0].pointerStatus, 'live');
  assert.equal(liveLink.elements[0].target.allocationId, target.rootId);
  assert.ok(Object.isFrozen(liveLink.elements[0].target));

  const messageCount = worker.messages.length;
  controller.previous();
  assert.equal(controller.state.arrays.find(array => array.name === 'links').elements[0].pointerStatus, 'uninitialized');
  controller.next();
  assert.equal(controller.state.arrays.find(array => array.name === 'links').elements[0].pointerStatus, 'live');
  assert.equal(worker.messages.length, messageCount, 'history navigation restores snapshots without advancing the Worker');
  assert.equal(controller.state.pointers[0].displayValue, standalone.displayValue);
  controller.dispose();
});
