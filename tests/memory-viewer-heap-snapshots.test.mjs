import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { createDebugSession, prepare } from '@playground/c11-engine/core';
import {
  chooseMemoryViewerHeapFocusId,
  compareMemoryViewerHeapObjects,
  latestFreedMemoryViewerHeapObject,
  memoryViewerHeapAliases,
  mergeMemoryViewerHeapViews,
  mergeMemoryViewerHeapObjects,
} from '../src/memory/heapSnapshots.ts';
import { MemoryViewerSnapshots } from '../src/memory/MemoryViewerSnapshots.ts';
import {
  completeMemoryViewerHeapExitPresentation,
  EMPTY_HEAP_EXIT_PRESENTATION,
  isMemoryViewerHeapEmpty,
  resolveMemoryViewerHeapExitPresentation,
  shouldDisplayMemoryViewerFreedHeapObject,
} from '../src/memory/MemoryViewerRegionModel.ts';
import { fixtureSourceFor } from '../packages/c11-engine/tests/p4-test-helpers.mjs';
import { createServer } from 'vite';

const block = (id, address, size = 8) => ({ id, address, size, origin: 'heap' });
const aggregate = (rootId, address, size, overrides = {}) => ({
  rootId,
  origin: 'heap',
  duration: 'heap',
  region: 'heap',
  frameId: null,
  scopeId: null,
  type: 'struct Packet',
  kind: 'struct',
  address,
  size,
  readOnly: false,
  memberCount: 2,
  status: 'available',
  members: [],
  padding: [],
  ...overrides,
});

function pointer(id, name, target, overrides = {}) {
  return {
    id,
    scopeId: 1,
    frameId: 1,
    name,
    origin: 'variable',
    duration: 'automatic',
    region: 'stack',
    type: 'int *',
    address: `0x${(0x20000 + id * 0x10).toString(16)}`,
    size: 8,
    initialized: true,
    displayValue: '0x3000',
    status: 'live',
    target,
    ...overrides,
  };
}

function renderHeapContents(HeapContents, LanguageProvider, props) {
  const t = key => key === 'memoryViewer.freed' ? 'Freed' : key;
  const emptyChanges = {
    stepIndex: -1,
    stackScalarIds: [],
    stackPointerIds: [],
    staticObjectIds: [],
    staticPointerIds: [],
    arrayElementKeys: [],
    aggregateMemberKeys: [],
  };
  return renderToStaticMarkup(createElement(LanguageProvider, { initialLanguage: 'en' },
    createElement(HeapContents, {
      stepIndex: 0,
      heapExitPresentation: EMPTY_HEAP_EXIT_PRESENTATION,
      valueChangePresentation: emptyChanges,
      freedHeapObject: null,
      highlightedAggregateTargetId: null,
      highlightedAggregateTargetFieldKey: null,
      highlightedPointerTarget: null,
      onPointerHoverChange: () => {},
      onPointerFocusChange: () => {},
      onFreedHeapExitComplete: () => {},
      t,
      ...props,
    })));
}

function heapObjectEvent(sequence, kind, allocationId, address, size = 8) {
  return {
    kind,
    sequence,
    location: { file: 'main.c', line: sequence, column: 1 },
    frameId: null,
    scopeId: null,
    objectId: allocationId,
    allocationId,
    duration: 'heap',
    origin: 'heap',
    typeSummary: 'untyped heap block',
    addressVirtual: BigInt(address),
    size,
  };
}

function lifecycleBatch(events, previous = null) {
  let latestFreedHeapEvent = previous?.latestFreedHeapEvent ?? null;
  for (const event of events) {
    if (event.kind === 'object-delete' && event.duration === 'heap' && event.origin === 'heap') {
      latestFreedHeapEvent = event;
    }
  }
  return { previous, events, latestFreedHeapEvent, eventCount: (previous?.eventCount ?? 0) + events.length };
}

test('heap transitions use the new ID when a historical address is reused', () => {
  const oldBlock = block(7, '0x4000', 16);
  const newBlock = block(8, '0x4000', 16);
  const transition = compareMemoryViewerHeapObjects([oldBlock], [newBlock]);

  assert.deepEqual(transition.created.map(({ id }) => id), [8]);
  assert.deepEqual(transition.deleted.map(({ id }) => id), [7]);
  assert.equal(chooseMemoryViewerHeapFocusId(transition), 8);
});

test('heap free focuses the released block ID and address even when no live blocks remain', () => {
  const before = [block(1, '0x1000'), block(2, '0x3000'), block(3, '0x8000')];
  const after = [before[0], before[2]];
  const transition = compareMemoryViewerHeapObjects(before, after);

  assert.deepEqual(transition.deleted.map(({ id }) => id), [2]);
  assert.equal(chooseMemoryViewerHeapFocusId(transition), 2);
  const finalFree = compareMemoryViewerHeapObjects([before[0]], []);
  assert.equal(chooseMemoryViewerHeapFocusId(finalFree), 1);
});

test('the selected event prefix keeps only its latest freed heap identity', () => {
  const first = block(31, '0x30000', 8);
  const second = block(32, '0x31000', 16);
  const firstDelete = lifecycleBatch([heapObjectEvent(1, 'object-delete', first.id, first.address, first.size)]);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(firstDelete), first, 'one freed block remains visible without any live blocks');

  const intermediate = lifecycleBatch([
    { kind: 'scope-enter', sequence: 2, frameId: 1, scopeId: 2, functionName: 'main', scopeName: 'main', location: { file: 'main.c', line: 2, column: 1 } },
  ], firstDelete);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(intermediate), first, 'a step without a delete retains the previous release');
  const twoFreesInOneStep = lifecycleBatch([
    heapObjectEvent(3, 'object-delete', first.id, first.address, first.size),
    heapObjectEvent(4, 'object-delete', second.id, second.address, second.size),
  ]);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(twoFreesInOneStep), second,
    'sequence order within one step selects the last delete event');

  const reallocFromNull = lifecycleBatch([
    heapObjectEvent(5, 'object-create', 33, second.address, 24),
  ], intermediate);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(reallocFromNull), first,
    'a creation without a deletion, including realloc(NULL, size), does not replace the released card');
  const freeNull = lifecycleBatch([], reallocFromNull);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(freeNull), first,
    'free(NULL), which has no delete event, leaves the previous card selected');

  const sameAddressRealloc = lifecycleBatch([
    heapObjectEvent(6, 'object-delete', second.id, second.address, second.size),
    heapObjectEvent(7, 'object-create', 34, second.address, 24),
  ], freeNull);
  const sameAddressReplacement = block(34, second.address, 24);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(sameAddressRealloc), second,
    'a successful realloc that retains its address still keeps the deleted allocation identity');

  const movedReplacement = block(35, '0x32000', 32);
  const movedRealloc = lifecycleBatch([
    heapObjectEvent(8, 'object-delete', sameAddressReplacement.id, sameAddressReplacement.address, sameAddressReplacement.size),
    heapObjectEvent(9, 'object-create', movedReplacement.id, movedReplacement.address, movedReplacement.size),
  ], sameAddressRealloc);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(movedRealloc), sameAddressReplacement,
    'a successful realloc that moves the block also retains the deleted allocation identity');

  const reallocToZero = lifecycleBatch([
    heapObjectEvent(10, 'object-delete', movedReplacement.id, movedReplacement.address, movedReplacement.size),
  ], movedRealloc);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(reallocToZero), movedReplacement,
    'realloc(p, 0) publishes a deletion without a replacement allocation');
  assert.equal(latestFreedMemoryViewerHeapObject(null), null, 'a new session has no prior released card');
});

test('lifecycle batches inherit or replace the freed heap event and preserve older checkpoints', () => {
  const history = new MemoryViewerSnapshots();
  const first = block(41, '0x33000', 8);
  const firstDelete = heapObjectEvent(1, 'object-delete', first.id, first.address, first.size);
  history.accept({ events: [firstDelete] });
  const firstCheckpoint = history.capture();
  const firstBatch = firstCheckpoint.lifecycle;

  assert.strictEqual(firstBatch.latestFreedHeapEvent, firstDelete);
  assert.equal(Object.isFrozen(firstBatch), true);
  assert.equal(Object.isFrozen(firstBatch.events), true);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(firstBatch), first,
    'a freed block remains available when the selected heap is empty');

  history.accept({ events: [
    { kind: 'scope-enter', sequence: 2, frameId: 1, scopeId: 2, functionName: 'main', scopeName: 'block', location: { file: 'main.c', line: 2, column: 1 } },
  ] });
  const betweenDeletes = history.capture();
  assert.strictEqual(betweenDeletes.lifecycle.previous, firstBatch,
    'new lifecycle batches preserve structural sharing with the earlier prefix');
  assert.strictEqual(betweenDeletes.lifecycle.latestFreedHeapEvent, firstDelete,
    'a batch without a free inherits the existing event reference');

  const second = block(42, '0x34000', 16);
  const secondDelete = heapObjectEvent(3, 'object-delete', second.id, second.address, second.size);
  history.accept({ events: [secondDelete] });
  const secondCheckpoint = history.capture();
  assert.strictEqual(secondCheckpoint.lifecycle.latestFreedHeapEvent, secondDelete,
    'a newer free replaces the event reference for later prefixes');
  assert.deepEqual(latestFreedMemoryViewerHeapObject(secondCheckpoint.lifecycle), second);

  const restoredFirst = history.materialize(firstCheckpoint);
  const restoredBetween = history.materialize(betweenDeletes);
  assert.strictEqual(restoredFirst.lifecycle, firstBatch);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(restoredFirst.lifecycle), first,
    'rewinding to the old checkpoint restores its released block');
  assert.strictEqual(restoredBetween.lifecycle.latestFreedHeapEvent, firstDelete);
  assert.deepEqual(latestFreedMemoryViewerHeapObject(restoredBetween.lifecycle), first,
    'rewinding to an intermediate prefix keeps the preceding release');
});

test('freed heap lookup reads the cached prefix event without traversing journal history', () => {
  const freed = block(43, '0x35000', 24);
  const cachedEvent = heapObjectEvent(4, 'object-delete', freed.id, freed.address, freed.size);
  let cachedEventReads = 0;
  const lifecycle = {
    get latestFreedHeapEvent() {
      cachedEventReads += 1;
      return cachedEvent;
    },
    get previous() { throw new Error('freed heap lookup traversed an earlier batch'); },
    get events() { throw new Error('freed heap lookup scanned the event batch'); },
  };

  assert.deepEqual(latestFreedMemoryViewerHeapObject(lifecycle), freed);
  assert.equal(cachedEventReads, 1, 'the selected prefix cache is read once');
});

test('heap ghosts stay at their prior address when a new block is inserted before a survivor', () => {
  const before = [block(1, '0x1000'), block(2, '0x3000'), block(3, '0x8000')];
  const current = [before[0], block(4, '0x5000'), before[2]];
  const transition = compareMemoryViewerHeapObjects(before, current);
  const displayed = mergeMemoryViewerHeapObjects(
    before.map(({ id }) => id),
    current,
    transition.deleted,
  );

  assert.deepEqual(displayed.map(({ id }) => id), [1, 2, 4, 3]);
  assert.deepEqual(displayed.map(({ address }) => address), ['0x1000', '0x3000', '0x5000', '0x8000']);
});

test('a complete aggregate view replaces the raw block from the same allocation', () => {
  const raw = block(4, '0x3000', 32);
  const views = mergeMemoryViewerHeapViews([raw], [aggregate(4, '0x3000', 32)]);

  assert.deepEqual(views.map(({ kind, id }) => [kind, id]), [['aggregate', 4]]);
});

test('heap aliases use live root identity and stable direct C paths', () => {
  const live = block(10, '0x3000', 32);
  const target = { allocationId: live.id, byteOffset: 0, type: 'int' };
  const pointers = [
    pointer(1, 'z', target),
    pointer(2, 'a', target),
    pointer(3, 'a', target),
    pointer(4, 'interior', { ...target, byteOffset: 4 }),
    pointer(5, 'one_past', { ...target, byteOffset: live.size }, { status: 'one-past' }),
    pointer(6, 'dangling', target, { status: 'dangling' }),
    pointer(7, 'uninitialized', target, { status: 'uninitialized', initialized: false }),
    pointer(8, 'old_allocation', { ...target, allocationId: 99 }),
  ];
  const pointerArray = {
    name: 'items',
    elements: [
      { index: 0, kind: 'pointer', initialized: true, pointerStatus: 'null' },
      { index: 1, kind: 'pointer', initialized: true, pointerStatus: 'live', target },
    ],
  };
  const holder = aggregate(20, '0x20000', 16, {
    name: 'holder',
    origin: 'variable',
    duration: 'automatic',
    region: 'stack',
    members: [{ kind: 'pointer', name: 'next', initialized: true, pointerStatus: 'live', target }],
  });

  assert.deepEqual([...memoryViewerHeapAliases([live], pointers, [pointerArray], [holder])], [
    [live.id, '*a, *holder.next, *items[1], *z'],
  ]);
});

test('ambiguous paths fall back for different, null, dangling, or interior destinations', () => {
  const first = block(21, '0x7000');
  const second = block(22, '0x8000');
  const firstTarget = { allocationId: first.id, byteOffset: 0, type: 'int' };

  assert.deepEqual([...memoryViewerHeapAliases([first, second], [
    pointer(1, 'p', firstTarget),
    pointer(2, 'p', { allocationId: second.id, byteOffset: 0, type: 'int' }),
  ], [], [])], [], 'the same identifier cannot label two different blocks');
  assert.deepEqual([...memoryViewerHeapAliases([first], [
    pointer(1, 'p', firstTarget),
    pointer(2, 'p', undefined, { status: 'null', displayValue: '0x0' }),
  ], [], [])], [], 'a null binding prevents an outer live binding from claiming the path');
  assert.deepEqual([...memoryViewerHeapAliases([first], [
    pointer(1, 'p', firstTarget),
    pointer(2, 'p', { ...firstTarget, byteOffset: 4 }),
  ], [], [])], [], 'an interior binding conflicts with a root binding of the same name');
  assert.deepEqual([...memoryViewerHeapAliases([first], [
    pointer(1, 'p', firstTarget),
    pointer(2, 'p', firstTarget, { status: 'dangling' }),
  ], [], [])], [], 'a dangling binding conflicts with a live binding of the same name');

  const arrayAlias = {
    name: 'items',
    elements: [{ index: 0, kind: 'pointer', initialized: true, pointerStatus: 'live', target: firstTarget }],
  };
  const nullArrayAlias = {
    name: 'items',
    elements: [{ index: 0, kind: 'pointer', initialized: true, pointerStatus: 'null' }],
  };
  assert.deepEqual([...memoryViewerHeapAliases([first], [], [arrayAlias, nullArrayAlias], [])], [],
    'pointer array cells with the same path also participate in ambiguity detection');

  const aggregateAlias = aggregate(31, '0x21000', 8, {
    name: 'holder', origin: 'variable', duration: 'automatic', region: 'stack',
    members: [{ kind: 'pointer', name: 'next', initialized: true, pointerStatus: 'live', target: firstTarget }],
  });
  const nullAggregateAlias = aggregate(32, '0x21020', 8, {
    name: 'holder', origin: 'variable', duration: 'automatic', region: 'stack',
    members: [{ kind: 'pointer', name: 'next', initialized: true, pointerStatus: 'null' }],
  });
  assert.deepEqual([...memoryViewerHeapAliases([first], [], [], [aggregateAlias, nullAggregateAlias])], [],
    'named aggregate pointer members with the same path also participate in ambiguity detection');
});

test('repeated path and target snapshots keep one deterministic alias', () => {
  const live = block(23, '0x9000');
  const target = { allocationId: live.id, byteOffset: 0, type: 'int' };
  const aliases = memoryViewerHeapAliases([live], [
    pointer(1, 'p', target),
    pointer(2, 'p', { ...target }),
  ], [], []);

  assert.deepEqual([...aliases], [[live.id, '*p']]);
});

test('reassignment follows the selected pointer history, including Previous snapshots', () => {
  const first = block(11, '0x3000');
  const second = block(12, '0x4000');
  const history = new MemoryViewerSnapshots();
  history.accept({
    events: [],
    heapObjects: [first, second],
    pointers: [pointer(1, 'a', { allocationId: first.id, byteOffset: 0, type: 'int' })],
    arrays: [],
    aggregates: [],
  });
  const beforeReassignment = history.capture();
  history.accept({
    events: [],
    heapObjects: [first, second],
    pointers: [pointer(1, 'a', { allocationId: second.id, byteOffset: 0, type: 'int' })],
    arrays: [],
    aggregates: [],
  });
  const afterReassignment = history.capture();

  const before = history.materialize(beforeReassignment);
  const after = history.materialize(afterReassignment);
  assert.deepEqual([...memoryViewerHeapAliases(before.heapObjects, before.pointers, before.arrays, before.aggregates)], [
    [first.id, '*a'],
  ]);
  assert.deepEqual([...memoryViewerHeapAliases(after.heapObjects, after.pointers, after.arrays, after.aggregates)], [
    [second.id, '*a'],
  ]);
  assert.deepEqual([...memoryViewerHeapAliases(before.heapObjects, before.pointers, before.arrays, before.aggregates)], [
    [first.id, '*a'],
  ], 'materializing the earlier checkpoint restores its alias without a stale render cache');
});

test('a dangling pointer does not label a new allocation at a reused address', () => {
  const freed = block(13, '0x5000');
  const reused = block(14, freed.address);
  const aliases = memoryViewerHeapAliases(
    [reused],
    [pointer(1, 'old', { allocationId: freed.id, byteOffset: 0, type: 'int' }, { status: 'dangling' })],
    [],
    [],
  );

  assert.equal(aliases.has(reused.id), false);
});

test('raw and typed heap cards share the alias for their allocation root', async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, ws: false },
  });
  try {
    const { MemoryViewerHeapContents } = await vite.ssrLoadModule('/src/memory/MemoryViewerHeapContents.tsx');
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const raw = block(15, '0x6000', 32);
    const pointers = [
      pointer(1, 'b', { allocationId: raw.id, byteOffset: 0, type: 'struct Packet' }),
      pointer(2, 'a', { allocationId: raw.id, byteOffset: 0, type: 'struct Packet' }),
    ];
    const rawMarkup = renderHeapContents(MemoryViewerHeapContents, LanguageProvider, {
      heapObjects: [raw], pointers, arrays: [], aggregates: [],
    });
    assert.match(rawMarkup, />\*a, \*b<\/span>/, 'the raw card shows sorted aliases');

    const typedMarkup = renderHeapContents(MemoryViewerHeapContents, LanguageProvider, {
      heapObjects: [raw],
      pointers: [pointers[0]],
      arrays: [],
      aggregates: [aggregate(raw.id, raw.address, raw.size)],
    });
    assert.match(typedMarkup, />\*b<\/span>/, 'the typed view uses its raw allocation root alias');
    assert.doesNotMatch(typedMarkup, /Aggregate on heap/);
  } finally {
    await vite.close();
  }
});

test('the heap view shows one noninteractive Freed card beside every live block', async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, ws: false },
  });
  try {
    const { MemoryViewerHeapContents } = await vite.ssrLoadModule('/src/memory/MemoryViewerHeapContents.tsx');
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const freed = block(50, '0x6000', 16);
    const reused = block(51, freed.address, 16);
    const otherLive = block(52, '0x7000', 8);
    const markup = renderHeapContents(MemoryViewerHeapContents, LanguageProvider, {
      heapObjects: [reused, otherLive],
      freedHeapObject: freed,
      pointers: [],
      arrays: [],
      aggregates: [aggregate(freed.id, freed.address, freed.size)],
    });

    assert.equal((markup.match(/data-memory-viewer-scalar-id=/g) ?? []).length, 3,
      'both live blocks and only the latest freed block are rendered');
    assert.match(markup, />Freed</, 'released memory has an explicit localized status value');
    const freedCardTag = markup.match(/<div class="memory-viewer-scalar[^\"]*memory-viewer-scalar--freed[^\"]*"[^>]*>/)?.[0];
    assert.ok(freedCardTag, 'the released block has a dedicated visual state');
    assert.match(freedCardTag, /data-memory-viewer-scalar-id="50"/, 'the card keeps the deleted allocation identity');
    assert.doesNotMatch(freedCardTag, /tabindex|data-pointer-target/, 'the card is not an interactive pointer target');
    assert.doesNotMatch(markup, /Aggregate on heap/, 'a stale aggregate snapshot cannot replace the released raw block');
  } finally {
    await vite.close();
  }
});

test('the final freed heap card exits before the empty heap state replaces its list', async () => {
  const freed = block(60, '0x8000', 16);
  const waiting = resolveMemoryViewerHeapExitPresentation(
    EMPTY_HEAP_EXIT_PRESENTATION,
    null,
    freed,
    4,
    [freed],
  );

  assert.equal(waiting.phase, 'waiting');
  assert.deepEqual(waiting.deletedObjects, [freed]);
  assert.equal(shouldDisplayMemoryViewerFreedHeapObject(freed, waiting), true);
  assert.equal(isMemoryViewerHeapEmpty([], [], freed, waiting), false,
    'the heap stays occupied while the released card is visible');

  const fading = { ...waiting, phase: 'fading' };
  assert.equal(shouldDisplayMemoryViewerFreedHeapObject(freed, fading), false,
    'the card leaves the list so AnimatePresence can run its 240 ms exit');
  assert.equal(isMemoryViewerHeapEmpty([], [], freed, fading), false,
    'the heap region stays open while the card is still exiting');

  const complete = completeMemoryViewerHeapExitPresentation(fading);
  assert.equal(complete.phase, 'complete');
  assert.deepEqual(complete.deletedObjects, [], 'completion drops the temporary released snapshot');
  assert.deepEqual(complete.previousObjectIds, [], 'completion releases the prior heap ordering snapshot');
  assert.equal(shouldDisplayMemoryViewerFreedHeapObject(freed, complete), false);
  assert.equal(isMemoryViewerHeapEmpty([], [], freed, complete), true,
    'the final release marks the heap empty only after the exit completes');
  assert.strictEqual(
    resolveMemoryViewerHeapExitPresentation(complete, freed, freed, 5, []),
    complete,
    'later prefixes that inherit the same cached free do not bring the completed card back');

  const previousRelease = block(59, '0x7000', 8);
  const rewound = resolveMemoryViewerHeapExitPresentation(complete, freed, previousRelease, 3, []);
  assert.equal(rewound.phase, 'waiting');
  assert.equal(rewound.deletedObjects[0].id, previousRelease.id,
    'rewinding to an earlier prefix presents that prefix’s latest release');
  const beforeAnyFree = resolveMemoryViewerHeapExitPresentation(rewound, previousRelease, null, 0, []);
  assert.equal(beforeAnyFree.phase, 'fading',
    'rewinding before any free exits the earlier released card instead of dropping it immediately');
  assert.equal(isMemoryViewerHeapEmpty([], [], null, beforeAnyFree), false,
    'the region waits until that rewind exit completes');
  assert.equal(isMemoryViewerHeapEmpty([], [], null, completeMemoryViewerHeapExitPresentation(beforeAnyFree)), true,
    'the region reaches its empty state after the rewind exit completes');

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, ws: false },
  });
  try {
    const { MemoryViewerHeapContents, MEMORY_VIEWER_HEAP_EXIT_DURATION_MS } = await vite.ssrLoadModule('/src/memory/MemoryViewerHeapContents.tsx');
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    assert.equal(MEMORY_VIEWER_HEAP_EXIT_DURATION_MS, 240,
      'the freed card and its collapse share the requested 240 ms exit');
    const visibleMarkup = renderHeapContents(MemoryViewerHeapContents, LanguageProvider, {
      heapObjects: [],
      freedHeapObject: freed,
      pointers: [],
      arrays: [],
      aggregates: [],
      heapExitPresentation: waiting,
    });
    assert.match(visibleMarkup, /data-memory-viewer-scalar-id="60"/,
      'the released card is mounted before its exit starts');

    const completedMarkup = renderHeapContents(MemoryViewerHeapContents, LanguageProvider, {
      heapObjects: [],
      freedHeapObject: freed,
      pointers: [],
      arrays: [],
      aggregates: [],
      heapExitPresentation: complete,
    });
    assert.match(completedMarkup, /memoryViewer\.empty/,
      'the completed transition replaces the heap list with its empty state');
    assert.doesNotMatch(completedMarkup, /memory-viewer-heap-list|data-memory-viewer-scalar-id=/,
      'no released list item remains stuck after completion');
  } finally {
    await vite.close();
  }
});

test('a partial or offset view preserves the complete raw block', () => {
  const raw = block(5, '0x4000', 32);
  const views = mergeMemoryViewerHeapViews([
    raw,
  ], [
    aggregate(5, '0x4000', 16),
    aggregate(5, '0x4008', 24),
  ]);

  assert.deepEqual(views.map(({ kind, id, snapshot }) => [kind, id, snapshot.address, snapshot.size]), [
    ['block', 5, '0x4000', 32],
  ]);
});

test('an earlier view does not replace a current allocation after realloc or address reuse', () => {
  const old = block(6, '0x5000', 16);
  const current = block(7, '0x5000', 24);
  const displayed = [old, current];
  const views = mergeMemoryViewerHeapViews(displayed, [aggregate(6, '0x5000', 16)], [current]);

  assert.deepEqual(views.map(({ kind, id }) => [kind, id]), [['block', 6], ['block', 7]]);
});

test('heap subviews preserve offset, size, and identity while keeping the complete raw block visible', () => {
  const name = 'heap-subobject-views.c';
  const source = fixtureSourceFor('p5', name);
  const prepared = prepare({ entry: name, files: [{ name, source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));

  const session = createDebugSession(prepared.program);
  const targetLine = source.split('\n').findIndex(line => line.includes('return first->left')) + 1;
  let progress;
  for (let index = 0; index < 1_000; index += 1) {
    progress = session.resume();
    if (progress.kind !== 'paused' || progress.location.line === targetLine) break;
  }
  assert.equal(progress?.kind, 'paused', JSON.stringify(progress));
  assert.equal(progress.location.line, targetLine);

  const blocks = session.inspectHeapObjects();
  const views = session.inspectAggregates().aggregates.filter(aggregate => aggregate.type.includes('Pair'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].size, 32);
  assert.equal(views.length, 2);
  assert.ok(views.every(view => view.rootId === blocks[0].id && view.size === 8));
  assert.deepEqual(views.map(view => [BigInt(view.address) - BigInt(blocks[0].address), view.size]).sort((a, b) => Number(a[0] - b[0])), [
    [8n, 8], [20n, 8],
  ]);
  assert.equal(new Set(views.map(view => view.viewId)).size, 2);
  assert.ok(views.every(view => view.viewId !== undefined));
  const displayed = mergeMemoryViewerHeapViews(blocks, views);
  assert.deepEqual(displayed.map(({ kind, id, snapshot }) => [kind, id, snapshot.address, snapshot.size]), [
    ['block', blocks[0].id, blocks[0].address, blocks[0].size],
  ]);
});
