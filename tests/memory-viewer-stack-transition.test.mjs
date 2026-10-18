import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseMemoryViewerStackFocusId,
  compareMemoryViewerStackSnapshots,
  findMemoryViewerChangedScalarIds,
  findEntrypointMainRootScopeId,
  mergeExitedItemsInPreviousOrder,
} from '../src/memory/stackTransition.ts';
import { MemoryViewerExitCleanupTimer, readMemoryViewerExitDuration } from '../src/memory/exitCleanup.ts';

function scalar(id, { scopeId = 1, initialized = true, displayValue = String(id) } = {}) {
  return {
    id,
    scopeId,
    frameId: 1,
    name: `value${id}`,
    type: 'int',
    address: `0x${id.toString(16)}`,
    size: 4,
    initialized,
    displayValue,
  };
}

test('value changes compare adjacent snapshots by ID, initialization, and exact display value', () => {
  const before = [
    scalar(1, { displayValue: '7' }),
    scalar(2, { initialized: false, displayValue: '?' }),
    scalar(3, { displayValue: '9' }),
  ];
  const after = [
    scalar(1, { displayValue: '7' }), // Same-value assignment does not produce a visual delta.
    scalar(2, { initialized: true, displayValue: '?' }),
    scalar(3, { displayValue: '10' }),
    scalar(4, { displayValue: '11' }), // Newly created objects are handled by the lifecycle transition.
  ];

  assert.deepEqual(findMemoryViewerChangedScalarIds(before, after), [2, 3]);

  const earlierStatic = [{ id: 20, initialized: true, displayValue: '41' }];
  const laterStatic = [{ id: 20, initialized: true, displayValue: '42' }];
  assert.deepEqual(findMemoryViewerChangedScalarIds(earlierStatic, laterStatic), [20]);
  assert.deepEqual(findMemoryViewerChangedScalarIds(laterStatic, earlierStatic), [20], 'moving Back marks the difference toward the selected state');
});

function scope(id, scopeName = `scope${id}`) {
  return {
    id,
    frameId: 1,
    functionName: 'main',
    scopeName,
    location: { file: 'main.c', line: id, column: 1 },
  };
}

test('selected snapshots compare real allocation IDs, not scalar writes or unselected future objects', () => {
  const before = [scalar(10, { displayValue: '1' })];
  const after = [scalar(10, { displayValue: '9' }), scalar(11)];
  const transition = compareMemoryViewerStackSnapshots(before, after, [scope(1)], [scope(1)]);

  assert.deepEqual(transition.createdScalars.map(item => item.id), [11]);
  assert.deepEqual(transition.deletedScalars, []);
  assert.equal(chooseMemoryViewerStackFocusId(transition, before, after), 11);
  assert.equal(before[0].displayValue, '1');
});

test('entrypoint root is identified by its first main frame and first scope ID', () => {
  const previous = {
    previous: null,
    events: [
      { kind: 'frame-enter', frameId: 1, scopeId: null, functionName: 'helper' },
      { kind: 'scope-enter', frameId: 1, scopeId: 10, functionName: 'helper', scopeName: 'helper' },
      { kind: 'frame-enter', frameId: 2, scopeId: null, functionName: 'main' },
      { kind: 'scope-enter', frameId: 2, scopeId: 20, functionName: 'main', scopeName: 'main' },
    ],
  };
  const current = {
    previous,
    events: [
      { kind: 'scope-enter', frameId: 2, scopeId: 21, functionName: 'main', scopeName: 'main' },
      { kind: 'frame-enter', frameId: 3, scopeId: null, functionName: 'main' },
      { kind: 'scope-enter', frameId: 3, scopeId: 30, functionName: 'main', scopeName: 'main' },
    ],
  };

  assert.equal(findEntrypointMainRootScopeId(current), 20);
  assert.equal(findEntrypointMainRootScopeId(null), null);
});

test('backing to a cached history snapshot reverses identity changes without inventing its future state', () => {
  const earlier = [scalar(10, { displayValue: '1' })];
  const later = [scalar(10, { displayValue: '3' }), scalar(11)];
  const forward = compareMemoryViewerStackSnapshots(earlier, later, [scope(1)], [scope(1), scope(2)]);
  const backward = compareMemoryViewerStackSnapshots(later, earlier, [scope(1), scope(2)], [scope(1)]);

  assert.deepEqual(forward.createdScalars.map(item => item.id), [11]);
  assert.deepEqual(backward.deletedScalars.map(item => item.id), [11]);
  assert.deepEqual(backward.exitedScopes.map(item => item.id), [2]);
  assert.deepEqual(backward.createdScalars, []);
  assert.equal(chooseMemoryViewerStackFocusId(backward, later, earlier), 11);
});

test('focus selection uses one last affected stack position for a group of changes', () => {
  const before = [scalar(1), scalar(2), scalar(3), scalar(4)];
  const after = [scalar(1), scalar(8), scalar(9)];
  const transition = compareMemoryViewerStackSnapshots(before, after, [scope(1)], [scope(1)]);

  assert.deepEqual(transition.deletedScalars.map(item => item.id), [2, 3, 4]);
  assert.deepEqual(transition.createdScalars.map(item => item.id), [8, 9]);
  assert.equal(chooseMemoryViewerStackFocusId(transition, before, after), 4);
});

test('exiting cards stay at their previous position and a reappearing ID is never duplicated', () => {
  const current = [scalar(1), scalar(3)];
  assert.deepEqual(
    mergeExitedItemsInPreviousOrder([1, 2, 3], current, [scalar(2)]).map(item => item.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    mergeExitedItemsInPreviousOrder([1, 2, 3], [scalar(1), scalar(2), scalar(3)], [scalar(2)])
      .map(item => item.id),
    [1, 2, 3],
  );
});

test('exit cleanup timer replaces old work, expires once, and clears on collapse or unmount', () => {
  const jobs = new Map();
  let nextHandle = 1;
  const scheduler = {
    setTimeout(callback, delayMs) {
      const handle = nextHandle++;
      jobs.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout(handle) {
      jobs.delete(handle);
    },
  };
  const timer = new MemoryViewerExitCleanupTimer(scheduler);
  let calls = 0;

  timer.schedule(() => { calls += 100; }, 220);
  const replacedHandle = [...jobs.keys()][0];
  timer.schedule(() => { calls += 1; }, 80);
  assert.equal(jobs.has(replacedHandle), false);
  assert.equal([...jobs.values()][0].delayMs, 80);

  const active = jobs.values().next().value;
  jobs.clear();
  active.callback();
  assert.equal(calls, 1);

  timer.schedule(() => { calls += 10; }, 220);
  timer.clear();
  assert.equal(jobs.size, 0);
  assert.equal(calls, 1);
});

test('exit duration follows the shared CSS duration and accepts reduced-motion short peeks', () => {
  const style = duration => ({ getPropertyValue: () => duration });
  assert.equal(readMemoryViewerExitDuration(style('220ms')), 220);
  assert.equal(readMemoryViewerExitDuration(style('0.08s')), 80);
  assert.equal(readMemoryViewerExitDuration(style('')), 220);
});
