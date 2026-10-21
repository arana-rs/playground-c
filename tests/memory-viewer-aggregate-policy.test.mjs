import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDebugSession, prepare } from '../packages/c11-engine/dist/core/index.js';
import {
  memoryViewerAggregateMemberPointerIdentity,
  resolveMemoryViewerPointerTarget,
} from '../src/memory/pointerSnapshots.ts';
import { createServer } from 'vite';

const source = `
enum Shade { dark = 2 };
struct Record {
  int first;
  struct { int nested; };
  int last;
};
struct Nested { int inner; };
struct Simple { int value; unsigned int : 3; char letter; enum Shade shade; int *link; int *null_link; int values[2]; struct Nested nested; };
union Choice { int value; double other; };
struct Wide { int a0; int a1; int a2; int a3; int a4; int a5; int a6; int a7; int a8; int a9; int a10; };
int target = 11;
int main(void) {
  struct Record record = { .first = 1, .nested = 2, .last = 3 };
  struct Simple simple = { .value = 7, .letter = 'C', .shade = dark, .link = &target, .values = { 1, 2 }, .nested = { .inner = 13 } };
  union Choice choice = { .value = 9 };
  struct Wide wide = { 0 };
  struct Record *record_pointer = &record;
  int *nested_pointer = &record.nested;
  int *field_pointer = &simple.value;
  return 0;
}
`;

function snapshotByName(snapshots, name) {
  const snapshot = snapshots.find(item => item.name === name);
  assert.ok(snapshot, `expected aggregate ${name}`);
  return snapshot;
}

function memberByName(aggregate, name) {
  const member = aggregate.members.find(item => item.name === name);
  assert.ok(member, `expected member ${name}`);
  return member;
}

test('aggregate members show supported values, object metadata, and valid pointer anchors', async () => {
  const prepared = prepare({ entry: 'memory-policy.c', files: [{ name: 'memory-policy.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const session = createDebugSession(prepared.program);
  const expectedAggregateNames = ['record', 'simple', 'choice', 'wide'];
  const expectedPointerNames = ['record_pointer', 'nested_pointer', 'field_pointer'];
  let observedAggregates = [];
  let observedPointers = [];
  let observedStaticObjects = [];

  for (let step = 0; step < 32; step += 1) {
    observedAggregates = session.inspectAggregates().aggregates;
    observedPointers = session.inspectPointers();
    observedStaticObjects = session.inspectStaticObjects();
    if (expectedAggregateNames.every(name => observedAggregates.some(item => item.name === name))
      && expectedPointerNames.every(name => observedPointers.some(item => item.name === name))) break;
    const progress = session.resume();
    assert.equal(progress.kind, 'paused', JSON.stringify(progress));
  }

  const record = snapshotByName(observedAggregates, 'record');
  const simple = snapshotByName(observedAggregates, 'simple');
  const choice = snapshotByName(observedAggregates, 'choice');
  const wide = snapshotByName(observedAggregates, 'wide');
  assert.equal(record.status, 'available');
  assert.ok(record.members.some(member => member.name === ''), 'the engine retains anonymous-member metadata');
  assert.ok(simple.members.some(member => member.name === '' && member.bitWidth === 3), 'the engine retains an unnamed bit-field');
  assert.equal(simple.status, 'available', 'an unnamed bit-field is not an anonymous aggregate member');
  const link = memberByName(simple, 'link');
  const nullLink = memberByName(simple, 'null_link');
  assert.equal(link.kind, 'pointer', 'the engine retains pointer-field metadata');
  assert.equal(link.pointerStatus, 'live');
  assert.match(link.displayValue, /^0x[\da-f]+$/i, 'the engine publishes the stored pointer address');
  assert.equal(nullLink.pointerStatus, 'null');
  assert.equal(nullLink.displayValue, '0x0', 'the null pointer retains its stored null representation');

  const recordPointer = observedPointers.find(item => item.name === 'record_pointer');
  const nestedPointer = observedPointers.find(item => item.name === 'nested_pointer');
  const fieldPointer = observedPointers.find(item => item.name === 'field_pointer');
  assert.equal(resolveMemoryViewerPointerTarget(recordPointer.id, observedPointers, [], [], observedAggregates)?.kind, 'aggregate-root',
    'a standalone pointer to an anonymous-member aggregate still targets its visible root');
  assert.equal(resolveMemoryViewerPointerTarget(nestedPointer.id, observedPointers, [], [], observedAggregates), null,
    'a standalone pointer to a hidden anonymous member has no missing field anchor');
  assert.equal(resolveMemoryViewerPointerTarget(fieldPointer.id, observedPointers, [], [], observedAggregates)?.fieldKey, memberByName(simple, 'value').key,
    'a standalone pointer still targets a displayed arithmetic field');
  assert.deepEqual(resolveMemoryViewerPointerTarget(
    memoryViewerAggregateMemberPointerIdentity(simple, link.key),
    observedPointers,
    observedStaticObjects,
    [],
    observedAggregates,
  ), { kind: 'object', allocationId: observedStaticObjects.find(item => item.name === 'target')?.id },
  'a displayed pointer member retains the usual target navigation behavior');

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, ws: false },
  });
  try {
    const { MemoryViewerAggregateBlock } = await vite.ssrLoadModule('/src/memory/MemoryViewer.tsx');
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const renderAggregate = aggregate => renderToStaticMarkup(createElement(LanguageProvider, {
      initialLanguage: 'en',
    }, createElement(MemoryViewerAggregateBlock, {
      aggregate,
      changedMemberKeys: new Set(),
    })));

    const recordMarkup = renderAggregate(record);
    assert.match(recordMarkup, /Struct with anonymous members/);
    assert.doesNotMatch(recordMarkup, /memory-viewer-aggregate-members|data-memory-viewer-aggregate-field-key/,
      'the anonymous Record displays one root placeholder instead of partial fields');
    assert.match(recordMarkup, new RegExp(`data-memory-viewer-aggregate-id="${record.rootId}"`));
    assert.ok(recordMarkup.includes(record.address), 'the root address remains visible');
    assert.match(recordMarkup, new RegExp(`size ${record.size} bytes`), 'the root size remains accessible');

    const simpleMarkup = renderAggregate(simple);
    for (const field of ['value', 'letter', 'shade']) {
      const value = memberByName(simple, field).displayValue;
      const renderedValue = value.replaceAll("'", '&#x27;');
      assert.ok(simpleMarkup.includes(renderedValue), `the field value ${field} (${value}) stays visible`);
    }
    assert.ok(simpleMarkup.includes(link.displayValue), 'a pointer field displays its stored address');
    assert.match(simpleMarkup, /memory-viewer-scalar--pointer[^\"]*\"[^>]*data-pointer-status="live"/,
      'a pointer field retains live pointer status');
    assert.match(simpleMarkup, /memory-viewer-scalar--pointer-null[^\"]*\"[^>]*data-pointer-status="null"/,
      'a null pointer field keeps its pointer status and existing NULL style');
    assert.equal([...simpleMarkup.matchAll(/tabindex="0"/g)].length, 2,
      'both pointer fields remain keyboard-focusable for target navigation');
    assert.match(simpleMarkup, />NULL</, 'a null pointer field displays NULL');
    assert.ok(simpleMarkup.includes(memberByName(simple, 'link').type), 'pointer-field type metadata remains visible');
    assert.doesNotMatch(simpleMarkup, /memory-viewer-aggregate-member-placeholder[^>]*>pointer<\/span>/,
      'a pointer field no longer renders the generic placeholder');
    for (const [field, placeholder] of [['values', 'array'], ['nested', 'aggregate']]) {
      assert.equal(memberByName(simple, field).unsupportedReason, field === 'values' ? 'array' : 'aggregate');
      assert.ok(simpleMarkup.includes(`>${placeholder}</span>`), `${field} has its own placeholder`);
    }
    const unionMarkup = renderAggregate(choice);
    assert.match(unionMarkup, /Union members are not displayed/);
    assert.doesNotMatch(unionMarkup, /memory-viewer-aggregate-members/);
    const wideMarkup = renderAggregate(wide);
    assert.match(wideMarkup, /Maximum 10 direct members/);
    assert.doesNotMatch(wideMarkup, /memory-viewer-aggregate-members/);
  } finally {
    await vite.close();
  }
});

test('aggregate pointer navigation selects the matching view when heap views share a root', () => {
  const target = { allocationId: 7, byteOffset: 0, type: 'int' };
  const pointerMember = key => ({
    key,
    kind: 'pointer',
    initialized: true,
    pointerStatus: 'live',
    target,
  });
  const firstView = { rootId: 42, members: [pointerMember('42:100:0')] };
  const laterView = { rootId: 42, members: [pointerMember('42:200:0')] };

  assert.deepEqual(resolveMemoryViewerPointerTarget(
    memoryViewerAggregateMemberPointerIdentity(laterView, '42:200:0'),
    [],
    [{ id: target.allocationId, type: target.type }],
    [],
    [firstView, laterView],
  ), { kind: 'object', allocationId: target.allocationId });
});
