import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDebugSession, prepare } from '../packages/c11-engine/dist/core/index.js';
import { resolveMemoryViewerPointerTarget } from '../src/memory/pointerSnapshots.ts';
import { createServer } from 'vite';

const source = `
enum Shade { dark = 2 };
struct Record {
  int first;
  struct { int nested; };
  int last;
};
struct Nested { int inner; };
struct Simple { int value; unsigned int : 3; char letter; enum Shade shade; int *link; int values[2]; struct Nested nested; };
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

test('aggregate placeholders keep visible values, object metadata, and valid pointer anchors', async () => {
  const prepared = prepare({ entry: 'memory-policy.c', files: [{ name: 'memory-policy.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const session = createDebugSession(prepared.program);
  const expectedAggregateNames = ['record', 'simple', 'choice', 'wide'];
  const expectedPointerNames = ['record_pointer', 'nested_pointer', 'field_pointer'];
  let observedAggregates = [];
  let observedPointers = [];

  for (let step = 0; step < 32; step += 1) {
    observedAggregates = session.inspectAggregates().aggregates;
    observedPointers = session.inspectPointers();
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
  assert.equal(memberByName(simple, 'link').kind, 'pointer', 'the engine retains pointer-field metadata');

  const recordPointer = observedPointers.find(item => item.name === 'record_pointer');
  const nestedPointer = observedPointers.find(item => item.name === 'nested_pointer');
  const fieldPointer = observedPointers.find(item => item.name === 'field_pointer');
  assert.equal(resolveMemoryViewerPointerTarget(recordPointer.id, observedPointers, [], [], observedAggregates)?.kind, 'aggregate-root',
    'a standalone pointer to an anonymous-member aggregate still targets its visible root');
  assert.equal(resolveMemoryViewerPointerTarget(nestedPointer.id, observedPointers, [], [], observedAggregates), null,
    'a standalone pointer to a hidden anonymous member has no missing field anchor');
  assert.equal(resolveMemoryViewerPointerTarget(fieldPointer.id, observedPointers, [], [], observedAggregates)?.fieldKey, memberByName(simple, 'value').key,
    'a standalone pointer still targets a displayed arithmetic field');

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
    assert.match(simpleMarkup, /class="memory-viewer-aggregate-member-placeholder"[^>]*>pointer<\/span>/,
      'a pointer field becomes an individual placeholder');
    assert.ok(simpleMarkup.includes(memberByName(simple, 'link').type), 'pointer-field type metadata remains visible');
    assert.ok(!simpleMarkup.includes(memberByName(simple, 'link').displayValue), 'the stored pointer value is not exposed as a field value');
    for (const [field, placeholder] of [['values', 'array'], ['nested', 'aggregate']]) {
      assert.equal(memberByName(simple, field).unsupportedReason, field === 'values' ? 'array' : 'aggregate');
      assert.ok(simpleMarkup.includes(`>${placeholder}</span>`), `${field} has its own placeholder`);
    }
    assert.doesNotMatch(simpleMarkup, /data-pointer-status=|data-pointer-target=|tabindex="0"/,
      'a placeholder pointer field does not leave a hover or focus anchor');

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
