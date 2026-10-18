import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDebugSession, prepare } from '../packages/c11-engine/dist/core/index.js';
import { PersistentSnapshotHistory } from '../src/memory/PersistentSnapshotHistory.ts';
import {
  cloneMemoryViewerAggregateSnapshot,
  sameMemoryViewerAggregateSnapshot,
} from '../src/memory/aggregateSnapshots.ts';
import { createServer } from 'vite';

const source = readFileSync(new URL('./fixtures/memory-viewer-flexible-array.c', import.meta.url), 'utf8');

function reachInputNeeded(session) {
  for (let index = 0; index < 1_000; index += 1) {
    const progress = session.resume();
    if (progress.kind === 'input-needed') return progress;
    if (progress.kind !== 'paused') assert.fail(`The session ended before waiting for input: ${progress.kind}`);
  }
  assert.fail('The session did not reach the scanf pause.');
}

function pauseBeforeLine(session, targetLine) {
  for (let index = 0; index < 500; index += 1) {
    const progress = session.resume();
    if (progress.kind !== 'paused' || progress.location.line === targetLine) return progress;
  }
  assert.fail(`The session did not reach line ${targetLine}.`);
}

function patchFlexibleArray(aggregate, patch) {
  return {
    ...aggregate,
    members: aggregate.members.map(member => member.name === 'data'
      ? { ...member, flexibleArray: { ...member.flexibleArray, ...patch } }
      : member),
  };
}

function createAggregateHistory() {
  return new PersistentSnapshotHistory(128, {
    getId: aggregate => aggregate.viewId ?? aggregate.rootId,
    sameSnapshot: sameMemoryViewerAggregateSnapshot,
    cloneSnapshot: cloneMemoryViewerAggregateSnapshot,
  });
}

test('Memory Viewer history retains initialized values in the FAM tail', async () => {
  const prepared = prepare({ entry: 'packet.c', files: [{ name: 'packet.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const session = createDebugSession(prepared.program);
  const firstWriteLine = source.split('\n').findIndex(line => line.includes("packet->data[0] = 'A'")) + 1;
  assert.ok(firstWriteLine > 0);
  assert.equal(pauseBeforeLine(session, firstWriteLine).kind, 'paused');

  const beforeAggregate = session.inspectAggregates().aggregates.find(item => item.type.includes('Packet') && item.duration === 'heap');
  assert.ok(beforeAggregate);
  const beforeTail = beforeAggregate.members.find(member => member.name === 'data');
  assert.equal(beforeAggregate.members.find(member => member.name === 'n')?.displayValue, '3');
  assert.deepEqual(beforeTail?.flexibleArray?.elements.map(element => element.initialized), [false, false, false]);

  assert.equal(reachInputNeeded(session).kind, 'input-needed');

  const heapObjects = session.inspectHeapObjects();
  const directAggregate = session.inspectAggregates().aggregates.find(item => item.type.includes('Packet') && item.duration === 'heap');
  assert.ok(directAggregate);
  assert.equal(heapObjects[0].size, 7);
  const directHeader = directAggregate.members.find(member => member.name === 'n');
  const directTail = directAggregate.members.find(member => member.name === 'data');
  assert.equal(directHeader?.displayValue, '3');
  assert.equal(directTail?.offset, 4);
  assert.deepEqual(directTail?.flexibleArray?.elements.map(element => [element.initialized, element.displayValue]), [
    [true, "'A'"], [true, "'B'"], [true, "'C'"],
  ]);

  const history = createAggregateHistory();
  const findPacket = snapshots => snapshots.find(item => item.type.includes('Packet') && item.duration === 'heap');
  history.accept([beforeAggregate]);
  const cachedBefore = findPacket(history.materialize(history.latestBatch));
  assert.ok(cachedBefore);
  assert.deepEqual(cachedBefore.members.find(member => member.name === 'data')?.flexibleArray?.elements.map(element => element.initialized), [false, false, false]);
  history.accept([directAggregate]);
  const aggregate = findPacket(history.materialize(history.latestBatch));
  assert.ok(aggregate);
  const header = aggregate.members.find(member => member.name === 'n');
  const tail = aggregate.members.find(member => member.name === 'data');
  assert.equal(header?.displayValue, '3');
  assert.equal(tail?.offset, 4);
  assert.deepEqual(tail?.flexibleArray?.elements.map(element => [element.initialized, element.displayValue]), [
    [true, "'A'"], [true, "'B'"], [true, "'C'"],
  ]);
  assert.equal(tail?.flexibleArray?.capacityBytes, 3);

  const equalCopy = {
    ...directAggregate,
    members: directAggregate.members.map(member => member.name === 'data'
      ? { ...member, flexibleArray: { ...member.flexibleArray, elements: member.flexibleArray.elements.map(element => ({ ...element })) } }
      : member),
  };
  assert.equal(sameMemoryViewerAggregateSnapshot(directAggregate, equalCopy), true,
    'two snapshots with the same FAM contents must compare equal');
  assert.equal(sameMemoryViewerAggregateSnapshot(directAggregate,
    patchFlexibleArray(directAggregate, { status: 'too-many-elements' })), false,
  'a change to FAM status invalidates the snapshot');
  assert.equal(sameMemoryViewerAggregateSnapshot(directAggregate,
    patchFlexibleArray(directAggregate, { omittedElements: directTail.flexibleArray.omittedElements + 1 })), false,
  'a change to FAM truncation invalidates the snapshot');

  const lastBatchBeforeIdentical = history.latestBatch;
  const lastSnapshotBeforeIdentical = findPacket(history.materialize(lastBatchBeforeIdentical));
  history.accept([equalCopy]);
  assert.equal(history.latestBatch, lastBatchBeforeIdentical, 'identical content reuses the persistent batch');
  assert.equal(findPacket(history.materialize(history.latestBatch)), lastSnapshotBeforeIdentical,
    'identical content retains the identity of the held DTO');

  for (const [field, patch] of [
    ['status', { status: 'too-many-elements' }],
    ['omittedElements', { omittedElements: directTail.flexibleArray.omittedElements + 1 }],
  ]) {
    const fieldHistory = createAggregateHistory();
    fieldHistory.accept([directAggregate]);
    const fieldInitialBatch = fieldHistory.latestBatch;
    const fieldInitialSnapshot = findPacket(fieldHistory.materialize(fieldInitialBatch));
    fieldHistory.accept([patchFlexibleArray(directAggregate, patch)]);
    assert.notEqual(fieldHistory.latestBatch, fieldInitialBatch, `changing only ${field} creates a new batch`);
    assert.notEqual(findPacket(fieldHistory.materialize(fieldHistory.latestBatch)), fieldInitialSnapshot,
      `changing only ${field} does not reuse the previous snapshot`);
  }

  const detachedInput = {
    ...directAggregate,
    members: directAggregate.members.map(member => member.name === 'data'
      ? { ...member, flexibleArray: { ...member.flexibleArray, elements: member.flexibleArray.elements.map(element => ({ ...element })) } }
      : member),
  };
  const detached = cloneMemoryViewerAggregateSnapshot(detachedInput);
  const detachedCells = detached.members.find(member => member.name === 'data').flexibleArray.elements;
  assert.notEqual(detachedCells, detachedInput.members.find(member => member.name === 'data').flexibleArray.elements);
  assert.notEqual(detachedCells[0], detachedInput.members.find(member => member.name === 'data').flexibleArray.elements[0]);
  assert.ok(Object.isFrozen(detachedCells));
  assert.ok(detachedCells.every(Object.isFrozen));

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  try {
    const { MemoryViewerAggregateBlock } = await vite.ssrLoadModule('/src/memory/MemoryViewer.tsx');
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const renderAggregate = value => renderToStaticMarkup(createElement(LanguageProvider, {
      initialLanguage: 'en',
    }, createElement(MemoryViewerAggregateBlock, {
      aggregate: value,
      changedMemberKeys: new Set(),
    })));
    const markup = renderAggregate(aggregate);
    assert.match(markup, /data-memory-viewer-fam-offset="4"/);
    assert.match(markup, /data-memory-viewer-fam-length="3"/);
    assert.match(markup, /data-memory-viewer-fam-capacity="3"/);
    assert.match(markup, /data-memory-viewer-aggregate-field-name="n"/);
    assert.match(markup, /aria-label="n, \(int\), address [^,]+, 3"/);
    const visibleChars = [...markup.matchAll(/class="memory-viewer-scalar-value"[^>]*>([ABC])<span class="memory-viewer-array-index"/g)]
      .map(match => match[1]);
    assert.deepEqual(visibleChars, ['A', 'B', 'C']);
    for (const [index, element] of tail.flexibleArray.elements.entries()) {
      const address = (BigInt(tail.address) + BigInt(index)).toString(16);
      const key = `data-memory-viewer-array-element-key="${element.key}"`;
      const elementOffset = markup.indexOf(key);
      assert.notEqual(elementOffset, -1);
      const cardStart = markup.lastIndexOf('<div ', elementOffset);
      const cardEnd = markup.indexOf('</div>', elementOffset) + '</div>'.length;
      const card = markup.slice(cardStart, cardEnd);
      assert.match(card, /data-initialized="true"/);
      assert.doesNotMatch(card, /memory-viewer-scalar--uninitialized|Uninitialized|—/);
      assert.ok(markup.includes(`title="0x${address}"`), `the interface shows address 0x${address}`);
    }

    const limitedSession = createDebugSession(prepared.program, undefined, { maxElementsPerArray: 2 });
    assert.equal(reachInputNeeded(limitedSession).kind, 'input-needed');
    const limitedAggregate = limitedSession.inspectAggregates().aggregates.find(item => item.type.includes('Packet') && item.duration === 'heap');
    assert.ok(limitedAggregate);
    const limitedMarkup = renderAggregate(limitedAggregate);
    const limitedChars = [...limitedMarkup.matchAll(/class="memory-viewer-scalar-value"[^>]*>([ABC])<span class="memory-viewer-array-index"/g)]
      .map(match => match[1]);
    assert.deepEqual(limitedChars, ['A', 'B']);
    assert.match(limitedMarkup, /\+1 elements omitted/);
  } finally {
    await vite.close();
  }
});
