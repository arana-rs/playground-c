import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseMemoryViewerHeapFocusId,
  compareMemoryViewerHeapObjects,
  mergeMemoryViewerHeapObjects,
} from '../src/memory/heapSnapshots.ts';

const block = (id, address, size = 8) => ({ id, address, size, origin: 'heap' });

test('heap transition usa el ID nuevo cuando se reutiliza una dirección histórica', () => {
  const oldBlock = block(7, '0x4000', 16);
  const newBlock = block(8, '0x4000', 16);
  const transition = compareMemoryViewerHeapObjects([oldBlock], [newBlock]);

  assert.deepEqual(transition.created.map(({ id }) => id), [8]);
  assert.deepEqual(transition.deleted.map(({ id }) => id), [7]);
  assert.equal(chooseMemoryViewerHeapFocusId(transition), 8);
});

test('heap free enfoca el ID y dirección del bloque liberado, aunque no queden bloques vivos', () => {
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
