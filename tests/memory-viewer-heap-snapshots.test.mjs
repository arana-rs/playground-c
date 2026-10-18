import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebugSession, prepare } from '@playground/c11-engine/core';
import {
  chooseMemoryViewerHeapFocusId,
  compareMemoryViewerHeapObjects,
  mergeMemoryViewerHeapViews,
  mergeMemoryViewerHeapObjects,
} from '../src/memory/heapSnapshots.ts';
import { fixtureSourceFor } from '../packages/c11-engine/tests/p4-test-helpers.mjs';

const block = (id, address, size = 8) => ({ id, address, size, origin: 'heap' });
const aggregate = (rootId, address, size) => ({
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
});

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
