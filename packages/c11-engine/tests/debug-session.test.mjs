import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, createDebugSession, createExecutionSession, DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS, execute, prepare, VIRTUAL_HEAP_LAYOUT, VIRTUAL_MEMORY_LAYOUT } from '../dist/core/index.js';
import { VirtualMemory } from '../dist/core/memory.js';
import { pointerTo } from '../dist/core/type-system.js';
import { decodeBytes, fixtureProject, prepareProject } from './p4-test-helpers.mjs';

const program = (name) => prepareProject(prepare, fixtureProject('debug', name));
const objects = (events, kind) => events.filter((event) => event.kind === kind);
const lifecycleKinds = new Set([
  'frame-enter', 'frame-exit', 'scope-enter', 'scope-exit', 'object-create', 'object-delete',
]);

function runToTerminal(session, maxSteps = 2_000) {
  const events = [...session.drainEvents()];
  const steps = [];
  const stepEvents = [];
  for (let index = 0; index < maxSteps; index += 1) {
    const progress = session.resume();
    steps.push(progress);
    const emitted = [...session.drainEvents()];
    events.push(...emitted);
    stepEvents.push(emitted);
    if (progress.kind !== 'paused') return { result: progress, events, steps, stepEvents };
    assert.deepEqual(session.currentLocation(), progress.location);
  }
  assert.fail(`DebugSession did not reach a terminal state in ${maxSteps} pauses.`);
}

function pauseBeforeLine(session, targetLine, maxSteps = 2_000) {
  for (let index = 0; index < maxSteps; index += 1) {
    const progress = session.resume();
    if (progress.kind !== 'paused' || progress.location.line === targetLine) return progress;
  }
  assert.fail(`DebugSession did not reach line ${targetLine} in ${maxSteps} pauses.`);
}

function advanceToInputNeeded(session, maxSteps = 2_000) {
  for (let index = 0; index < maxSteps; index += 1) {
    const progress = session.resume();
    if (progress.kind === 'input-needed') return progress;
    assert.equal(progress.kind, 'paused', JSON.stringify(progress));
  }
  assert.fail(`DebugSession did not request stdin within ${maxSteps} pauses.`);
}

function assertLifecycleOnly(events) {
  assert.ok(events.every((event) => lifecycleKinds.has(event.kind)));
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.ok(events.every((event) => !('value' in event) && !('before' in event) && !('after' in event)));
}

test('aggregate inspection publishes direct fields and layout without changing the VM', () => {
  const source = `struct Inner { short code; };
union Choice { int count; char bytes[8]; };
struct Sample {
  char lead;
  int count;
  int *link;
  int values[2];
  struct Inner inner;
  union Choice choice;
  char tail;
};
union RootChoice { long integer; double ratio; };
struct Wide { int f0; int f1; int f2; int f3; int f4; int f5; int f6; int f7; int f8; int f9; int f10; };
struct Sample global_sample;
union RootChoice global_union;
struct Wide global_wide;
int main(void) {
  struct Sample raw;
  struct Sample *alias = &raw;
  union RootChoice local_union;
  struct Wide wide;
  struct Sample partial;
  struct Sample zero = { 0 };
  raw.lead = 'L';
  raw.count = 7;
  raw.link = &raw.count;
  raw.values[0] = 2;
  raw.values[1] = 3;
  raw.inner.code = 4;
  raw.choice.count = 8;
  raw.tail = 'T';
  alias->count = 9;
  struct Sample copy = raw;
  partial.count = 7;
  raw.count = 11;
  struct Sample later;
  return copy.count;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-aggregate-snapshot.c',
    files: [{ name: 'debug-aggregate-snapshot.c', source }],
  });
  assert.equal(DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers, 10);
  const beforeWriteLine = source.split('\n').findIndex((line) => line.trim() === 'raw.count = 11;') + 1;
  const laterReturnLine = source.split('\n').findIndex((line) => line.trim() === 'return copy.count;') + 1;
  const session = createDebugSession(prepared);
  const pause = pauseBeforeLine(session, beforeWriteLine);
  assert.equal(pause.kind, 'paused');
  const locationBefore = session.currentLocation();
  session.drainEvents();

  const inspection = session.inspectAggregates();
  assert.deepEqual(session.inspectAggregates(), inspection, 'querying twice does not change the current snapshot');
  assert.deepEqual(session.currentLocation(), locationBefore, 'inspection does not advance execution');
  assert.deepEqual(session.drainEvents(), [], 'inspection does not create subobjects or events');
  assert.deepEqual(structuredClone(inspection), inspection, 'the complete DTO is serializable');
  assert.equal(inspection.omittedObjects, 0);

  const byName = (name) => inspection.aggregates.find((aggregate) => aggregate.name === name);
  const raw = byName('raw');
  assert.equal(raw.status, 'available');
  assert.equal(raw.kind, 'struct');
  assert.equal(raw.region, 'stack');
  assert.equal(raw.memberCount, 7);
  assert.deepEqual(raw.members.map(({ name, kind, offset, size }) => [name, kind, offset, size]), [
    ['lead', 'arithmetic', 0, 1], ['count', 'arithmetic', 4, 4], ['link', 'pointer', 8, 8],
    ['values', 'unsupported', 16, 8], ['inner', 'unsupported', 24, 2],
    ['choice', 'unsupported', 28, 8], ['tail', 'arithmetic', 36, 1],
  ]);
  assert.equal(raw.size, 40);
  assert.deepEqual(raw.padding.map(({ offset, size }) => [offset, size]), [[1, 3], [26, 2], [37, 3]]);
  assert.equal(raw.members[1].initialized, true);
  assert.equal(raw.members[1].displayValue, '9', 'assignment through -> reaches the same field');
  assert.equal(raw.members[2].pointerStatus, 'live');
  assert.deepEqual(
    { allocationId: raw.members[2].target.allocationId, byteOffset: raw.members[2].target.byteOffset },
    { allocationId: raw.rootId, byteOffset: 4 },
  );
  assert.deepEqual(raw.members.slice(3, 6).map(({ initialized, displayValue, unsupportedReason }) => [initialized, displayValue, unsupportedReason]), [
    [null, null, 'array'], [null, null, 'aggregate'], [null, null, 'aggregate'],
  ]);

  const partial = byName('partial');
  assert.deepEqual(
    partial.members.slice(0, 3).map(({ name, initialized, displayValue }) => [name, initialized, displayValue]),
    [['lead', false, '?'], ['count', true, '7'], ['link', false, '?']],
    'uninitialized automatic fields are published without reading them as C',
  );
  const zero = byName('zero');
  assert.deepEqual(
    zero.members.slice(0, 3).map(({ initialized, displayValue, pointerStatus }) => [initialized, displayValue, pointerStatus]),
    [[true, "'\\0'", undefined], [true, '0', undefined], [true, '0x0', 'null']],
  );
  assert.equal(byName('local_union').status, 'unsupported-union');
  assert.deepEqual(byName('local_union').members, []);
  assert.equal(byName('wide').status, 'too-many-members');
  assert.equal(byName('wide').memberCount, 11);
  assert.deepEqual(byName('wide').members, []);
  assert.equal(byName('global_sample').duration, 'static');
  assert.equal(byName('global_sample').region, 'static');
  assert.deepEqual(byName('global_sample').members.slice(0, 3).map(({ initialized, displayValue }) => [initialized, displayValue]), [
    [true, "'\\0'"], [true, '0'], [true, '0x0'],
  ]);
  assert.equal(byName('global_union').status, 'unsupported-union');
  assert.equal(byName('global_wide').status, 'too-many-members');

  const previousRaw = raw;
  const updatePause = session.resume();
  assert.equal(updatePause.kind, 'paused');
  assert.equal(session.inspectAggregates().aggregates.find((aggregate) => aggregate.name === 'raw').members[1].displayValue, '11');
  assert.equal(previousRaw.members[1].displayValue, '9', 'a saved snapshot does not track later mutations');
  assert.equal(byName('copy').members[1].displayValue, '9', 'a by-value copy keeps its own history');

  const baseline = createDebugSession(prepared);
  assert.equal(pauseBeforeLine(baseline, beforeWriteLine).kind, 'paused');
  assert.equal(pauseBeforeLine(session, laterReturnLine).kind, 'paused');
  assert.equal(pauseBeforeLine(baseline, laterReturnLine).kind, 'paused');
  assert.equal(
    session.inspectAggregates().aggregates.find((aggregate) => aggregate.name === 'later').rootId,
    baseline.inspectAggregates().aggregates.find((aggregate) => aggregate.name === 'later').rootId,
    'inspection does not materialize members that consume internal IDs',
  );
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 9, 'inspection does not alter C execution');
});

test('the session prepares globals and main, then starts before the first instruction executes', () => {
  const prepared = program('debug-main-bootstrap.c');
  const session = createDebugSession(prepared);
  const initialEvents = session.drainEvents();

  const initialLocation = session.currentLocation();
  assert.equal(initialLocation.file, 'debug-main-bootstrap.c');
  assert.equal(initialLocation.line, 5);
  assert.ok(initialLocation.column > 0);
  assert.deepEqual(session.inspectScalars(), [], 'main’s root scope does not publish future declarations');
  assert.equal(objects(initialEvents, 'object-create').filter((event) => event.duration === 'automatic').length, 0);
  assert.ok(objects(initialEvents, 'object-create').some((event) => event.name === 'global_value'));
  assert.ok(objects(initialEvents, 'object-create').some((event) => event.name === 'global_alias'));

  const run = runToTerminal(session);
  assert.equal(run.steps[0].kind, 'paused');
  assert.equal(run.steps[0].location.line, 6);
  assert.equal(run.steps[1].kind, 'paused');
  assert.equal(run.steps[1].location.line, 7);
  assert.deepEqual(objects(run.stepEvents[0], 'object-create').map((event) => event.name), ['local_value']);
  assert.deepEqual(objects(run.stepEvents[1], 'object-create').map((event) => event.name), ['copied_value']);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  assert.equal(session.currentLocation(), null);
  assertLifecycleOnly([...initialEvents, ...run.events]);
});

test('automatic objects appear when their declarations execute and follow actual scope entry', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-declaration-timing.c',
    files: [{ name: 'debug-declaration-timing.c', source: `int main(void) {
  int a = 2;
  int b;
  {
    int nested = 3;
    b = nested;
  }
  return a + b;
}` }],
  });
  const session = createDebugSession(prepared);
  const events = [...session.drainEvents()];
  assert.deepEqual(session.inspectScalars(), []);
  assert.equal(objects(events, 'object-create').some((event) => event.name), false);

  let progress = session.resume();
  assert.equal(progress.kind, 'paused');
  events.push(...session.drainEvents());
  assert.deepEqual(objects(events, 'object-create').filter((event) => event.name).map((event) => event.name), ['a']);
  assert.deepEqual(session.inspectScalars().map(({ name, initialized, displayValue }) => ({ name, initialized, displayValue })), [
    { name: 'a', initialized: true, displayValue: '2' },
  ]);

  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  events.push(...session.drainEvents());
  assert.deepEqual(session.inspectScalars().map(({ name, initialized, displayValue }) => ({ name, initialized, displayValue })), [
    { name: 'a', initialized: true, displayValue: '2' },
    { name: 'b', initialized: false, displayValue: '?' },
  ]);
  assert.equal(objects(events, 'object-create').some((event) => event.name === 'nested'), false);

  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  const enterEvents = session.drainEvents();
  events.push(...enterEvents);
  const entered = objects(enterEvents, 'scope-enter');
  assert.equal(entered.length, 1, 'the nested block enters at its source action');
  assert.equal(session.inspectScalars().some((scalar) => scalar.name === 'nested'), false);

  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  const nestedDeclarationEvents = session.drainEvents();
  events.push(...nestedDeclarationEvents);
  const nestedCreate = objects(nestedDeclarationEvents, 'object-create').find((event) => event.name === 'nested');
  assert.ok(nestedCreate);
  assert.deepEqual(session.inspectScalars().map(({ name, initialized, displayValue }) => ({ name, initialized, displayValue })), [
    { name: 'a', initialized: true, displayValue: '2' },
    { name: 'b', initialized: false, displayValue: '?' },
    { name: 'nested', initialized: true, displayValue: '3' },
  ]);

  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  events.push(...session.drainEvents());
  assert.equal(session.inspectScalars().find((scalar) => scalar.name === 'b')?.displayValue, '3');
  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  const closingEvents = session.drainEvents();
  events.push(...closingEvents);
  assert.ok(objects(closingEvents, 'object-delete').some((event) => event.allocationId === nestedCreate.allocationId));
  assert.ok(objects(closingEvents, 'scope-exit').some((event) => event.scopeId === nestedCreate.scopeId));
  assert.equal(session.inspectScalars().some((scalar) => scalar.name === 'nested'), false);

  progress = session.resume();
  assert.equal(progress.kind, 'terminated');
  events.push(...session.drainEvents());
  const creates = objects(events, 'object-create');
  const deletes = objects(events, 'object-delete');
  assert.deepEqual(creates.map((event) => event.name), ['a', 'b', 'nested']);
  assert.deepEqual(new Set(deletes.map((event) => event.allocationId)), new Set(creates.map((event) => event.allocationId)));
  assertLifecycleOnly(events);
});

test('resume groups statements on one line and enters the selected branch scope', () => {
  const session = createDebugSession(program('debug-line-groups.c'));
  assert.equal(session.currentLocation().line, 2);

  const run = runToTerminal(session);
  const paused = run.steps.filter((step) => step.kind === 'paused');
  assert.deepEqual(paused.map((step) => step.location.line), [3, 4]);
  assert.equal(run.result.kind, 'terminated');
  const created = objects(run.events, 'object-create');
  assert.ok(created.some((event) => event.name === 'same_line'));
  assert.ok(created.some((event) => event.name === 'selected'));
  assert.ok(!created.some((event) => event.name === 'skipped'));
  assert.ok(objects(run.events, 'scope-exit').length >= 2);
  assertLifecycleOnly(run.events);
});

test('a repeated PC in one activation can advance through single-line loops and gotos', () => {
  const session = createDebugSession(program('debug-loop-goto.c'));
  const run = runToTerminal(session, 100);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));

  const pausedLines = run.steps
    .filter((step) => step.kind === 'paused')
    .map((step) => step.location.line);
  assert.ok(pausedLines.filter((line) => line === 3).length > 1, pausedLines.join(','));
  assert.ok(pausedLines.filter((line) => line === 4).length > 1, pausedLines.join(','));
  assert.ok(pausedLines.includes(5));
  assertLifecycleOnly(run.events);
});

test('recursive calls enter at their first line and keep distinct dynamic frames', () => {
  const session = createDebugSession(program('recursion-frames.c'));
  assert.equal(session.currentLocation().line, 8);

  const run = runToTerminal(session);
  assert.equal(run.steps[0].kind, 'paused');
  assert.equal(run.steps[0].location.file, 'recursion-frames.c');
  assert.equal(run.steps[0].location.line, 1);
  assert.ok(run.stepEvents[0].some((event) => event.kind === 'frame-enter' && event.functionName === 'descend'));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const events = run.events;
  const saved = objects(events, 'object-create').filter((event) => event.name === 'saved');
  assert.equal(saved.length, 4);
  assert.equal(new Set(saved.map((event) => event.frameId)).size, 4);
  assert.equal(new Set(saved.map((event) => event.scopeId)).size, 4);
  assert.equal(new Set(saved.map((event) => event.objectId)).size, 4);
  const enteredFrames = objects(events, 'frame-enter').map((event) => event.frameId);
  assert.equal(enteredFrames.length, 5);
  assert.equal(new Set(enteredFrames).size, 5);
  assert.deepEqual(
    new Set(objects(events, 'frame-exit').map((event) => event.frameId)),
    new Set(enteredFrames),
  );
  assert.deepEqual(
    new Set(objects(events, 'frame-exit').filter((event) => event.functionName === 'descend').map((event) => event.location.line)),
    new Set([3, 4]),
  );
  assertLifecycleOnly(events);
});

test('the example’s compound while body uses one C scope per iteration and keeps the canonical label', () => {
  const run = runToTerminal(createDebugSession(program('linked-list-scopes.c')));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const appendFrames = objects(run.events, 'frame-enter').filter((event) => event.functionName === 'appendNode');
  const appendFrameIds = new Set(appendFrames.map((event) => event.frameId));
  assert.equal(appendFrames.length, 4);
  assert.equal(objects(run.events, 'frame-exit').filter((event) => appendFrameIds.has(event.frameId)).length, 4);

  const loopName = 'while(...)';
  const loopEnters = objects(run.events, 'scope-enter').filter((event) => event.scopeName === loopName);
  const loopExits = objects(run.events, 'scope-exit').filter((event) => event.scopeName === loopName);
  assert.equal(loopEnters.length, 6, 'the list visits 1 + 2 + 3 nodes before leaving the while loop');
  assert.equal(loopExits.length, loopEnters.length);
  assert.equal(new Set(loopEnters.map((event) => event.scopeId)).size, 6);
  assert.deepEqual(
    new Set(loopExits.map((event) => event.scopeId)),
    new Set(loopEnters.map((event) => event.scopeId)),
  );

  const activeScopes = [];
  const loopStacks = [];
  for (const event of run.events.filter((item) => item.kind === 'scope-enter' || item.kind === 'scope-exit')) {
    if (event.kind === 'scope-enter') {
      activeScopes.push(event);
      if (event.scopeName === loopName) loopStacks.push(activeScopes.map((scope) => scope.scopeName));
    } else {
      const index = activeScopes.findIndex((scope) => scope.scopeId === event.scopeId);
      assert.notEqual(index, -1, `scope ${event.scopeId} must have a preceding enter event`);
      activeScopes.splice(index, 1);
    }
  }
  assert.deepEqual(loopStacks.slice(0, 3), [
    ['main', 'appendNode', loopName],
    ['main', 'appendNode', loopName],
    ['main', 'appendNode', loopName],
  ]);
  assert.deepEqual(loopStacks.slice(3), [
    ['main', 'block', 'appendNode', loopName],
    ['main', 'block', 'appendNode', loopName],
    ['main', 'block', 'appendNode', loopName],
  ]);
  assert.deepEqual(activeScopes, [], 'all real scopes exit when main finishes');
  assertLifecycleOnly(run.events);
});

test('if, else, for, do, switch and bare blocks preserve scopes and automatic-object ownership', () => {
  const prepared = prepareProject(prepare, {
    entry: 'scope-names.c',
    files: [{ name: 'scope-names.c', source: `int main(void) {
  int n = 0;
  if (n == 0) { int branch = 1; n += branch; } else { int skipped = 2; }
  do { n++; } while (n < 2);
  for (int index = 0; index < 2; index++) {
    int loop = index;
    switch (loop) {
      case 0: { int choice = 1; n += choice; break; }
      default: n += 1;
    }
  }
  { int bare = 0; n += bare; }
  return n == 4 ? 0 : 1;
}` }],
  });
  const run = runToTerminal(createDebugSession(prepared));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const enters = objects(run.events, 'scope-enter');
  const exits = objects(run.events, 'scope-exit');
  const counts = (name) => enters.filter((event) => event.scopeName === name).length;
  assert.equal(counts('main'), 1);
  assert.equal(counts('if(...)'), 1);
  assert.equal(counts('else'), 0, 'the else block is not entered');
  assert.equal(counts('do { ... } while (...)'), 1);
  assert.equal(counts('for(...)'), 1);
  assert.equal(counts('for block'), 2);
  assert.equal(counts('switch(...)'), 2);
  assert.equal(counts('block'), 2, 'a case block and a bare block');
  assert.deepEqual(
    new Set(exits.map((event) => event.scopeId)),
    new Set(enters.map((event) => event.scopeId)),
  );

  const scopeNamesById = new Map(enters.map((event) => [event.scopeId, event.scopeName]));
  for (const name of ['branch', 'loop', 'choice', 'bare']) {
    const created = objects(run.events, 'object-create').find((event) => event.name === name);
    const deleted = objects(run.events, 'object-delete').find((event) => event.allocationId === created?.allocationId);
    assert.ok(created, `${name} must have an automatic object creation`);
    assert.ok(deleted, `${name} must end when its block closes`);
    assert.equal(deleted.scopeId, created.scopeId);
    assert.equal(scopeNamesById.get(created.scopeId), name === 'branch' ? 'if(...)' : name === 'choice' ? 'block' : name === 'bare' ? 'block' : 'for block');
  }
  assert.equal(objects(run.events, 'object-create').some((event) => event.name === 'skipped'), false);
  assertLifecycleOnly(run.events);
});

test('continue and break close each iteration’s real scope without losing local ownership', () => {
  const prepared = prepareProject(prepare, {
    entry: 'loop-exits.c',
    files: [{ name: 'loop-exits.c', source: `int main(void) {
  int index = 0;
  int total = 0;
  while (index < 4) {
    int local = index;
    index++;
    if (local == 1) continue;
    if (local == 3) break;
    total += local;
  }
  return total == 2 ? 0 : 1;
}` }],
  });
  const run = runToTerminal(createDebugSession(prepared));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const loopName = 'while(...)';
  const loopEnters = objects(run.events, 'scope-enter').filter((event) => event.scopeName === loopName);
  const loopExits = objects(run.events, 'scope-exit').filter((event) => event.scopeName === loopName);
  assert.equal(loopEnters.length, 4);
  assert.deepEqual(
    new Set(loopExits.map((event) => event.scopeId)),
    new Set(loopEnters.map((event) => event.scopeId)),
  );
  const locals = objects(run.events, 'object-create').filter((event) => event.name === 'local');
  const localDeletes = objects(run.events, 'object-delete').filter((event) => event.name === 'local');
  assert.equal(locals.length, 4);
  assert.equal(localDeletes.length, 4);
  assert.deepEqual(
    new Set(localDeletes.map((event) => event.allocationId)),
    new Set(locals.map((event) => event.allocationId)),
  );
  assert.ok(locals.every((event) => loopEnters.some((scope) => scope.scopeId === event.scopeId)));
  assert.ok(localDeletes.every((event) => loopExits.some((scope) => scope.scopeId === event.scopeId)));
  assertLifecycleOnly(run.events);
});

test('function fallthrough pauses at its closing brace and keeps nested scope locations', () => {
  const session = createDebugSession(program('debug-function-close.c'));
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const paused = run.steps.filter((step) => step.kind === 'paused');
  const finalPrint = paused.findIndex((step) => step.location.file === 'debug-function-close.c' && step.location.line === 19);
  assert.notEqual(finalPrint, -1);
  assert.deepEqual(
    paused.slice(finalPrint, finalPrint + 3).map((step) => [step.location.file, step.location.line]),
    [
      ['debug-function-close.c', 19],
      ['debug-function-close.c', 20],
      ['debug-function-close.c', 27],
    ],
  );

  const showEntry = objects(run.events, 'frame-enter').find((event) => event.functionName === 'show');
  const showExit = objects(run.events, 'frame-exit').find((event) => event.frameId === showEntry?.frameId);
  assert.ok(showEntry);
  assert.equal(showEntry.location.file, 'debug-function-close.c');
  assert.equal(showEntry.location.line, 8);
  assert.ok(showExit);
  assert.equal(showExit.location.file, 'debug-function-close.c');
  assert.equal(showExit.location.line, 20);

  const showScopeExits = objects(run.events, 'scope-exit').filter((event) => event.frameId === showEntry.frameId);
  assert.ok(showScopeExits.some((event) => event.location.line === 15));
  assert.ok(showScopeExits.some((event) => event.location.line === 17));
  assert.ok(showScopeExits.some((event) => event.location.line === 20));
  assertLifecycleOnly(run.events);
});

test('static objects and string literals persist and are reported only once', () => {
  const session = createDebugSession(program('static-and-string.c'));
  const initialEvents = session.drainEvents();
  assert.ok(objects(initialEvents, 'object-create').some((event) => event.name === 'file_count'));
  assert.equal(objects(initialEvents, 'frame-enter').length, 1);
  assert.ok(!objects(initialEvents, 'object-create').some((event) => event.name === 'visits'));
  assert.equal(session.currentLocation().line, 10);

  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  const events = [...initialEvents, ...run.events];
  const created = objects(events, 'object-create');
  assert.equal(created.filter((event) => event.name === 'visits').length, 1);
  const fileCount = created.find((event) => event.name === 'file_count');
  const visits = created.find((event) => event.name === 'visits');
  const neverReached = created.find((event) => event.name === 'never_reached');
  const literal = created.filter((event) => event.origin === 'string-literal');
  assert.ok(fileCount);
  assert.ok(visits);
  assert.equal(neverReached, undefined);
  assert.equal(literal.length, 1);
  assert.ok([fileCount, visits, literal[0]].every((event) => event.duration === 'static'));
  assert.ok([fileCount, visits, literal[0]].every((event) => event.frameId === null && event.scopeId === null));
  assert.ok([fileCount, visits, literal[0]].every((event) => event.location.line > 0 && event.location.column > 0));
  const persistentIds = new Set([fileCount.allocationId, visits.allocationId, literal[0].allocationId]);
  assert.ok(!objects(events, 'object-delete').some((event) => persistentIds.has(event.allocationId)));
  const enteredScopes = objects(events, 'scope-enter');
  const exitedScopes = objects(events, 'scope-exit');
  assert.equal(enteredScopes.length, 5);
  assert.equal(exitedScopes.length, 5);
  assert.deepEqual(
    new Set(exitedScopes.map((event) => event.scopeId)),
    new Set(enteredScopes.map((event) => event.scopeId)),
  );
  assert.equal(new Set(enteredScopes.map((event) => event.scopeId)).size, enteredScopes.length);
  assertLifecycleOnly(events);
});

test('static inspection publishes actual scalars and literals and preserves local statics across calls', () => {
  const session = createDebugSession(program('static-memory-inspection.c'));
  const initialEvents = [...session.drainEvents()];
  const initialLocation = session.currentLocation();
  const staticScalarsOnly = session.inspectStaticObjects({ includeStringLiterals: false });
  assert.deepEqual(staticScalarsOnly.map(({ name, origin }) => ({ name, origin })), [
    { name: 'global_zero', origin: 'variable' },
    { name: 'global_value', origin: 'variable' },
  ], 'the option omits literals before building their full preview');
  const initialSnapshots = session.inspectStaticObjects();

  assert.deepEqual(initialSnapshots.map(({ name, origin, type, initialized, displayValue }) => ({ name, origin, type, initialized, displayValue })), [
    { name: 'global_zero', origin: 'variable', type: 'int', initialized: true, displayValue: '0' },
    { name: 'global_value', origin: 'variable', type: 'long', initialized: true, displayValue: '41' },
    { name: undefined, origin: 'string-literal', type: 'char[12]', initialized: true, displayValue: '"A\\n\\0001B\\001ABA\\"\\\\\\000"' },
  ]);
  assert.deepEqual(session.currentLocation(), initialLocation, 'inspection does not advance the VM');
  assert.deepEqual(session.drainEvents(), [], 'inspection does not publish events');
  assert.deepEqual(structuredClone(initialSnapshots), initialSnapshots, 'DTOs remain serializable');
  assert.ok(initialSnapshots.every((snapshot) => !('scopeId' in snapshot) && !('frameId' in snapshot)));

  const observations = [];
  const events = [...initialEvents];
  let progress;
  for (let index = 0; index < 100; index += 1) {
    progress = session.resume();
    events.push(...session.drainEvents());
    observations.push({ location: session.currentLocation(), snapshots: session.inspectStaticObjects() });
    if (progress.kind !== 'paused') break;
  }
  assert.equal(progress.kind, 'terminated', JSON.stringify(progress));
  assert.equal(progress.mainReturn, 0);

  const visitsAt = (line) => observations
    .filter((observation) => observation.location?.line === line)
    .map((observation) => observation.snapshots.find((snapshot) => snapshot.name === 'visits')?.displayValue);
  assert.deepEqual(visitsAt(7), ['2', '3'], 'explicit initialization happens once and is then preserved across frames');
  assert.deepEqual(visitsAt(8), ['3', '4'], 'writes are observed without a write event');
  assert.equal(observations.find((observation) => observation.location?.line === 13)?.snapshots.find((snapshot) => snapshot.name === 'visits')?.displayValue, '3', 'the local static persists when returning to main');

  const created = objects(events, 'object-create');
  const snapshots = [initialSnapshots, ...observations.map((observation) => observation.snapshots)].flat();
  for (const snapshot of snapshots) {
    const create = created.find((event) => event.allocationId === snapshot.id);
    assert.ok(create, String(snapshot.name ?? snapshot.displayValue) + ' matches its actual object-create event');
    assert.equal(create.duration, 'static');
    assert.equal(create.origin, snapshot.origin);
    assert.equal(snapshot.address, '0x' + create.addressVirtual.toString(16));
    assert.equal(snapshot.size, create.size);
    assert.equal(create.frameId, null);
    assert.equal(create.scopeId, null);
  }
  const visitsId = created.find((event) => event.name === 'visits')?.allocationId;
  assert.ok(visitsId);
  assert.equal(created.filter((event) => event.allocationId === visitsId).length, 1);
  assert.equal(objects(events, 'object-delete').some((event) => event.allocationId === visitsId), false);
  assert.equal(session.inspectScalars().length, 0, 'normal termination closes automatic scalars');
  assert.equal(session.inspectStaticObjects().find((snapshot) => snapshot.id === visitsId)?.displayValue, '4', 'static objects retain their value after main exits');
  assertLifecycleOnly(events);
});

test('array inspection preserves actual C cells and is noninvasive', () => {
  assert.deepEqual(DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS, {
    maxObjects: 1_000,
    maxElementsPerArray: 10,
    maxValueChars: 256,
  });
  const source = `long long global_big[2] = { 9007199254740993LL, -2LL };
const int global_const[2] = { 5, 6 };
char *literal_ref = "A\\n";
int main(void) {
  int values[4] = { 10, 20 };
  char text[5] = "good";
  char raw[3] = "abc";
  int untouched[2];
  _Bool flags[2] = { 0, 2 };
  float floats[1] = { 1.5f };
  double doubles[1] = { -0.0 };
  const char fixed[2] = { 'Q', '\\t' };
  values[0]++;
  ++values[1];
  values[2] = 9;
  return 0;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-array-values.c',
    files: [{ name: 'debug-array-values.c', source }],
  });
  const session = createDebugSession(prepared, undefined, { maxElementsPerArray: 10 });
  const updateLine = source.split('\n').findIndex((line) => line.trim() === 'values[0]++;') + 1;
  const pause = pauseBeforeLine(session, updateLine);
  assert.equal(pause.kind, 'paused');
  assert.equal(pause.location.line, updateLine);

  const beforeInspectionLocation = session.currentLocation();
  const events = [...session.drainEvents()];
  const inspection = session.inspectArrays();
  assert.deepEqual(session.inspectArrays(), inspection, 'repeated queries return the same current state');
  assert.deepEqual(session.currentLocation(), beforeInspectionLocation, 'inspection does not advance execution');
  assert.deepEqual(session.drainEvents(), [], 'inspection does not create objects or events');
  assert.deepEqual(structuredClone(inspection), inspection, 'the DTO remains serializable');
  assert.equal(inspection.omittedObjects, 0);

  const byName = (name) => inspection.arrays.find((array) => array.name === name);
  const values = byName('values');
  assert.deepEqual(values.elements.map(({ index, initialized, displayValue }) => [index, initialized, displayValue]), [
    [0, true, '10'], [1, true, '20'], [2, true, '0'], [3, true, '0'],
  ], 'partial initialization leaves the remainder at zero');
  assert.equal(values.status, 'available');
  assert.equal(values.region, 'stack');
  assert.equal(values.elements[0].key, `${values.rootId}:0`);
  assert.equal(values.elements[3].key, `${values.rootId}:3`);
  assert.equal(values.elements[3].address, `0x${(BigInt(values.address) + 12n).toString(16)}`);
  assert.ok(Number.isInteger(values.frameId) && Number.isInteger(values.scopeId));

  const text = byName('text');
  assert.deepEqual(text.elements.map(({ displayValue }) => displayValue), ["'g'", "'o'", "'o'", "'d'", "'\\0'"]);
  assert.equal(text.elements.length, 5, 'the terminator occupies a real cell');
  const raw = byName('raw');
  assert.deepEqual(raw.elements.map(({ displayValue }) => displayValue), ["'a'", "'b'", "'c'"]);
  assert.equal(raw.elements.length, 3, 'a char array without NUL is valid and does not receive an invented terminator');
  assert.deepEqual(byName('untouched').elements.map(({ initialized, displayValue }) => [initialized, displayValue]), [
    [false, '?'], [false, '?'],
  ], 'each uninitialized automatic element keeps the engine’s indeterminate state');
  assert.deepEqual(byName('flags').elements.map(({ displayValue }) => displayValue), ['0', '1']);
  assert.equal(byName('floats').elements[0].displayValue, '1.5');
  assert.equal(byName('doubles').elements[0].displayValue, '-0');
  assert.deepEqual(byName('fixed').elements.map(({ displayValue }) => displayValue), ["'Q'", "'\\t'"]);
  assert.equal(byName('fixed').readOnly, true);

  const global = byName('global_big');
  assert.equal(global.region, 'static');
  assert.equal(global.scopeId, null);
  assert.equal(global.frameId, null);
  assert.deepEqual(global.elements.map(({ displayValue }) => displayValue), ['9007199254740993', '-2'], 'LP64 preserves exact BigInt values');
  assert.equal(byName('global_const').readOnly, true);
  const literal = inspection.arrays.find((array) => array.origin === 'string-literal');
  assert.ok(literal);
  assert.equal(literal.type, 'char[3]');
  assert.equal(literal.readOnly, true);
  assert.deepEqual(literal.elements.map(({ displayValue }) => displayValue), ["'A'", "'\\n'", "'\\0'"]);
  assert.ok(session.inspectStaticObjects().some((object) => object.id === literal.rootId && object.origin === 'string-literal'),
    'the new channel preserves identity with the literal published by the previous API');

  const creates = objects(events, 'object-create');
  for (const array of inspection.arrays) {
    const create = creates.find((event) => event.allocationId === array.rootId);
    assert.ok(create, `root ${array.rootId} matches object-create`);
    assert.equal(array.address, `0x${create.addressVirtual.toString(16)}`);
    assert.equal(array.size, create.size);
  }

  let progress = session.resume();
  assert.equal(progress.kind, 'paused');
  assert.equal(session.inspectArrays().arrays.find((array) => array.name === 'values').elements[0].displayValue, '11', 'postfix updates the cell');
  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  assert.equal(session.inspectArrays().arrays.find((array) => array.name === 'values').elements[1].displayValue, '21', 'prefix updates the cell');
  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  assert.equal(session.inspectArrays().arrays.find((array) => array.name === 'values').elements[2].displayValue, '9', 'indexed assignment updates the element');
});

test('pointer arrays publish bounded cells with the existing pointer states and direct targets', () => {
  const source = `#include <stdlib.h>
#include <string.h>
int add_one(int value) { return value + 1; }
int *global_pointers[1] = { 0 };
_Thread_local int *tls_pointers[1] = { 0 };
int main(void) {
  int values[2] = { 10, 20 };
  int *current = &values[0];
  int **chain[1] = { &current };
  int *pointers[7];
  pointers[0] = &values[1];
  pointers[1] = 0;
  pointers[2] = values + 2;
  int *heap = malloc(sizeof(int));
  *heap = 4;
  pointers[3] = heap;
  free(heap);
  {
    int local = 5;
    pointers[4] = &local;
  }
  unsigned char invalid[sizeof(int *)] = { 1 };
  memcpy(&pointers[5], invalid, sizeof pointers[5]);
  int (*functions[2])(int) = { add_one, 0 };
  int bound = 2;
  int *runtime[bound];
  runtime[0] = &values[0];
  int *large[11] = { 0 };
  return 0;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointer-array-cells.c',
    files: [{ name: 'debug-pointer-array-cells.c', source }],
  });
  const session = createDebugSession(prepared, undefined, { maxElementsPerArray: 20, maxValueChars: 1 });
  const returnLine = source.split('\n').findIndex((line) => line.trim() === 'return 0;') + 1;
  assert.equal(pauseBeforeLine(session, returnLine).kind, 'paused');

  const location = session.currentLocation();
  const eventsBeforeInspection = session.drainEvents();
  const inspection = session.inspectArrays();
  assert.deepEqual(session.inspectArrays(), inspection, 'repeated queries return the same pointer values');
  assert.deepEqual(session.currentLocation(), location, 'pointer inspection does not advance execution');
  assert.deepEqual(session.drainEvents(), [], 'pointer inspection does not materialize element objects or events');
  assert.deepEqual(structuredClone(inspection), inspection, 'the complete DTO remains serializable');

  const byName = (name) => inspection.arrays.find((array) => array.name === name);
  const values = byName('values');
  const pointers = byName('pointers');
  assert.equal(pointers.status, 'available');
  assert.equal(pointers.rootId,
    objects(eventsBeforeInspection, 'object-create').find((event) => event.name === 'pointers')?.allocationId,
    'the pointer array retains its real allocation identity');
  assert.equal(pointers.elements.length, 7);
  assert.deepEqual(pointers.elements.map(({ kind, initialized, pointerStatus }) => [kind, initialized, pointerStatus]), [
    ['pointer', true, 'live'], ['pointer', true, 'null'], ['pointer', true, 'one-past'],
    ['pointer', true, 'dangling'], ['pointer', true, 'dangling'], ['pointer', true, 'unmapped'],
    ['pointer', false, 'uninitialized'],
  ]);
  assert.deepEqual(pointers.elements.map(({ key, index }) => [key, index]),
    pointers.elements.map((element, index) => [`${pointers.rootId}:${index}`, index]));
  assert.equal(pointers.elements[0].address, pointers.address,
    'the first cell address is the pointer object storage at the array base');
  assert.equal(pointers.elements[1].address, `0x${(BigInt(pointers.address) + 8n).toString(16)}`,
    'the next pointer cell advances by one pointer-sized element');
  assert.equal(pointers.elements[0].displayValue, values.elements[1].address,
    'the stored pointer value identifies values[1]');
  assert.equal(pointers.elements[0].valueTruncated, false, 'pointer addresses remain exact when scalar display values are capped');
  const directChain = byName('chain').elements[0];
  const currentPointer = session.inspectPointers().find((pointer) => pointer.name === 'current');
  assert.equal(directChain.displayValue, currentPointer.address,
    'the array cell stores the address of the pointer object, without following its value');
  assert.deepEqual(
    { allocationId: directChain.target.allocationId, byteOffset: directChain.target.byteOffset, name: directChain.target.name, type: directChain.target.type },
    { allocationId: currentPointer.id, byteOffset: 0, name: 'current', type: 'int *' },
  );
  assert.notEqual(directChain.displayValue, currentPointer.displayValue);
  assert.equal('kind' in values.elements[0], false, 'arithmetic cells keep their existing serialized shape');
  assert.equal(Object.isFrozen(pointers.elements[0]), true);
  assert.equal(Object.isFrozen(pointers.elements[0].target), true);
  assert.deepEqual(
    { allocationId: pointers.elements[0].target.allocationId, byteOffset: pointers.elements[0].target.byteOffset, type: pointers.elements[0].target.type },
    { allocationId: values.rootId, byteOffset: 4, type: 'int' },
  );
  assert.equal(pointers.elements[1].displayValue, '0x0');
  assert.equal(pointers.elements[2].target.byteOffset, 8);
  assert.match(pointers.elements[3].displayValue, /^0x[0-9a-f]+$/,
    'a freed allocation keeps its exact virtual address');
  assert.equal(pointers.elements[5].displayValue, '0x1');
  assert.equal(pointers.elements[5].target, undefined, 'raw bytes do not invent destination identity');
  assert.equal(pointers.elements[6].displayValue, '?');
  assert.equal(pointers.elements[6].valueTruncated, false);
  assert.equal(byName('runtime').status, 'available', 'a small VLA of pointers uses its captured bound');
  assert.deepEqual(byName('runtime').elements.map(({ initialized, pointerStatus }) => [initialized, pointerStatus]), [
    [true, 'live'], [false, 'uninitialized'],
  ]);
  assert.equal(byName('global_pointers').origin, 'variable');
  assert.equal(byName('global_pointers').duration, 'static');
  assert.equal(byName('global_pointers').region, 'static');
  assert.deepEqual(byName('global_pointers').elements.map(({ pointerStatus }) => pointerStatus), ['null']);
  assert.equal(byName('tls_pointers').duration, 'thread-local');
  assert.equal(byName('tls_pointers').region, 'static');
  assert.deepEqual(byName('tls_pointers').elements.map(({ pointerStatus }) => pointerStatus), ['null']);
  assert.deepEqual(byName('functions').elements.map(({ kind, pointerStatus, target }) => [kind, pointerStatus, target]), [
    ['pointer', 'function', undefined], ['pointer', 'null', undefined],
  ]);
  assert.equal(byName('large').status, 'too-many-elements', 'pointer arrays stay capped at ten even if the host raises its cell budget');
  assert.deepEqual(byName('large').elements, []);
  const pointerSnapshots = session.inspectPointers();
  const scalarHeapPointer = pointerSnapshots.find((pointer) => pointer.name === 'heap');
  assert.equal(scalarHeapPointer.status, pointers.elements[3].pointerStatus,
    'array cells reuse the standalone pointer lifetime classification');
  assert.equal(scalarHeapPointer.displayValue, pointers.elements[3].displayValue);
  assert.equal(scalarHeapPointer.target.allocationId, pointers.elements[3].target.allocationId);
  assert.equal(pointerSnapshots.some((pointer) => pointer.name === 'pointers'), false,
    'an array root does not create duplicate standalone pointer snapshots');

  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0, 'inspection leaves C execution unchanged');
});

test('large arrays, matrices and unsupported element types keep bounded descriptors without stopping C', () => {
  const source = `int main(void) {
  int large[11] = { 0 };
  char text[] = "abcdefghij";
  int matrix[2][2] = { { 1, 2 }, { 3, 4 } };
  int *pointers[2] = { 0, 0 };
  struct Cell { int value; };
  struct Cell cells[1] = { { 7 } };
  int ten[10] = { 0 };
  unsigned long long magnitude[1] = { 18446744073709551615ULL };
  return 7;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-array-bounds.c',
    files: [{ name: 'debug-array-bounds.c', source }],
  });
  const options = { maxObjects: 20, maxElementsPerArray: 10, maxValueChars: 4 };
  const session = createDebugSession(prepared, undefined, options);
  const returnLine = source.split('\n').findIndex((line) => line.trim() === 'return 7;') + 1;
  const pause = pauseBeforeLine(session, returnLine);
  assert.equal(pause.kind, 'paused');
  const { arrays, omittedObjects } = session.inspectArrays();
  const byName = (name) => arrays.find((array) => array.name === name);
  assert.equal(omittedObjects, 0);
  assert.equal(byName('large').status, 'too-many-elements');
  assert.equal(byName('large').length, 11);
  assert.deepEqual(byName('large').elements, []);
  assert.equal(byName('text').status, 'too-many-elements');
  assert.equal(byName('text').length, 11, 'the cap includes the NUL that completes char text[]');
  assert.deepEqual(byName('text').elements, []);
  assert.equal(byName('matrix').status, 'multidimensional');
  assert.deepEqual(byName('matrix').elements, []);
  assert.equal(byName('pointers').status, 'available');
  assert.deepEqual(byName('pointers').elements.map(({ kind, pointerStatus, displayValue }) => [kind, pointerStatus, displayValue]), [
    ['pointer', 'null', '0x0'], ['pointer', 'null', '0x0'],
  ]);
  assert.equal(byName('cells').status, 'unsupported-element-type');
  assert.deepEqual(byName('cells').elements, []);
  assert.equal(byName('ten').status, 'available');
  assert.deepEqual(byName('ten').elements.map(({ index }) => index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const magnitude = byName('magnitude').elements[0];
  assert.equal(magnitude.displayValue, '1844');
  assert.equal(magnitude.valueTruncated, true);

  const capped = createDebugSession(prepared, undefined, { maxObjects: 2, maxElementsPerArray: 10 });
  const cappedPause = pauseBeforeLine(capped, returnLine);
  assert.equal(cappedPause.kind, 'paused');
  const cappedInspection = capped.inspectArrays();
  assert.equal(cappedInspection.arrays.length, 2);
  assert.equal(cappedInspection.omittedObjects, 5, 'only roots excluded by maxObjects count as omitted');
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 7, 'the array display limit does not limit engine execution');
});

test('inspection follows live roots across scopes, shadowing and distinct frames', () => {
  const source = `int helper(void) {
  int values[1] = { 4 };
  return values[0];
}
int main(void) {
  int values[1] = { 1 };
  {
    int values[1] = { 2 };
    values[0] = 3;
    int result = helper();
    return result;
  }
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-array-scopes.c',
    files: [{ name: 'debug-array-scopes.c', source }],
  });
  const session = createDebugSession(prepared);
  let arrays;
  for (let index = 0; index < 100; index += 1) {
    const progress = session.resume();
    assert.equal(progress.kind, 'paused');
    arrays = session.inspectArrays().arrays.filter((array) => array.name === 'values');
    if (arrays.length === 3) break;
  }
  assert.equal(arrays.length, 3, 'both shadowed objects and the helper array are distinct live roots');
  assert.equal(new Set(arrays.map((array) => array.rootId)).size, 3);
  assert.equal(new Set(arrays.map((array) => array.frameId)).size, 2);
  assert.equal(new Set(arrays.map((array) => array.scopeId)).size, 3);
  assert.deepEqual(arrays.map((array) => array.elements[0].displayValue).sort(), ['1', '3', '4'],
    'the outer root retains 1, its shadow reflects the write to 3, and the helper retains 4');

  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.deepEqual(session.inspectArrays().arrays, [], 'automatic roots disappear when their scopes exit');
});

test('malloc and free report the heap lifecycle; free(NULL) adds no events', () => {
  const run = runToTerminal(createDebugSession(program('heap-lifetimes.c')));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  const heapCreates = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  const heapDeletes = objects(run.events, 'object-delete').filter((event) => event.origin === 'heap');
  assert.equal(heapCreates.length, 1);
  assert.equal(heapDeletes.length, 1);
  assert.equal(heapCreates[0].allocationId, heapDeletes[0].allocationId);
  assert.equal(heapCreates[0].size, 16);
  assert.equal(heapCreates[0].frameId, null);
  assert.equal(heapCreates[0].scopeId, null);
  assert.equal(heapDeletes[0].frameId, null);
  assert.equal(heapDeletes[0].scopeId, null);
  assert.equal(heapCreates[0].location.line, 4);
  assert.equal(heapDeletes[0].location.line, 7);
  assertLifecycleOnly(run.events);
});

test('heap inspection publishes ordered actual addresses, respects sizes and disappears after free', () => {
  assert.deepEqual(VIRTUAL_HEAP_LAYOUT, {
    start: 0x0003_0000n,
    endExclusive: 0x0004_0000n,
    alignmentBytes: 16,
  });
  assert.deepEqual(CAPABILITIES.virtualMemory.heapAddressRange, {
    start: '0x30000',
    endExclusive: '0x40000',
    capacityBytes: 65536,
    alignmentBytes: 16,
    guardBytes: 16,
    randomization: 'non-cryptographic per allocation',
  });
  const trace = (heapAddressSeed) => {
    const session = createDebugSession(program('heap-inspection.c'), undefined, { heapAddressSeed });
    const observations = [{ line: session.currentLocation()?.line, blocks: session.inspectHeapObjects() }];
    const events = [...session.drainEvents()];
    let result;
    for (let index = 0; index < 100; index += 1) {
      const line = session.currentLocation()?.line;
      const progress = session.resume();
      events.push(...session.drainEvents());
      observations.push({ line, blocks: session.inspectHeapObjects() });
      if (progress.kind !== 'paused') { result = progress; break; }
    }
    return { events, observations, result, live: session.inspectHeapObjects() };
  };

  const first = trace(0x1234_5678);
  const second = trace(0x1234_5678);
  assert.equal(first.result.kind, 'terminated', JSON.stringify(first.result));
  assert.deepEqual(first.live, []);
  assert.deepEqual(
    objects(first.events, 'object-create').filter((event) => event.origin === 'heap'),
    objects(second.events, 'object-create').filter((event) => event.origin === 'heap'),
    'the seed makes addresses reproducible in tests',
  );

  const created = objects(first.events, 'object-create').filter((event) => event.origin === 'heap');
  const deleted = objects(first.events, 'object-delete').filter((event) => event.origin === 'heap');
  const creationsById = new Map(created.map((event) => [event.allocationId, event]));
  for (const { blocks } of first.observations) {
    assert.deepEqual(blocks.map(({ address }) => BigInt(address)),
      [...blocks].map(({ address }) => BigInt(address)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    'blocks are ordered by exact virtual address');
    for (const block of blocks) {
      const creation = creationsById.get(block.id);
      assert.ok(creation, 'ID matches an actual object-create event');
      assert.equal(block.address, `0x${creation.addressVirtual.toString(16)}`);
      assert.equal(block.size, creation.size);
      assert.equal(block.origin, 'heap');
      const address = BigInt(block.address);
      assert.ok(address >= VIRTUAL_HEAP_LAYOUT.start && address < VIRTUAL_HEAP_LAYOUT.endExclusive);
      assert.equal(address % BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes), 0n, 'the start satisfies the published LP64 alignment');
    }
    for (let left = 0; left < blocks.length; left += 1) {
      const leftStart = BigInt(blocks[left].address);
      const leftEnd = leftStart + BigInt(blocks[left].size);
      for (let right = left + 1; right < blocks.length; right += 1) {
        const rightStart = BigInt(blocks[right].address);
        const rightEnd = rightStart + BigInt(blocks[right].size);
        assert.ok(leftEnd <= rightStart || rightEnd <= leftStart, 'live ranges do not overlap');
      }
    }
  }
  const afterFreeSecond = first.observations.find(({ line }) => line === 7)?.blocks ?? [];
  assert.equal(afterFreeSecond.length, 2);
  assert.equal(afterFreeSecond.some(({ id }) => id === deleted[0]?.allocationId), false,
    'free removes the released block from inspection');
  assert.equal(created.length, 4);
  assert.equal(deleted.length, 4);
});

test('heap bases stay compact while random placement can precede, follow, or fill a gap', () => {
  const randomValues = [0.99, 0.99, 0.4, 0];
  let randomIndex = 0;
  const location = { file: 'heap-compact-placement.test.c', line: 1, column: 1 };
  const memory = new VirtualMemory([], null, { peakMemoryBytes: 0 }, () => randomValues[randomIndex++] ?? 0);
  const allocate = () => {
    const pointer = memory.allocateRaw(1, location);
    assert.ok(pointer);
    return memory.describeObject(memory.rootReference(pointer.allocationId), location).addressVirtual;
  };

  const first = allocate();
  const after = allocate();
  assert.deepEqual([first, after], [0x30020n, 0x30060n]);
  const between = allocate();
  const before = allocate();
  assert.deepEqual([first, after, between, before], [0x30020n, 0x30060n, 0x30040n, 0x30000n]);
  assert.ok([first, after, between, before].every((address) => address % 0x10n === 0n));
});

test('the virtual layout publishes disjoint Static, Stack and Heap regions with shared guards and capacity', () => {
  assert.deepEqual(VIRTUAL_MEMORY_LAYOUT, {
    alignmentBytes: 16,
    guardBytes: 16,
    staticAddressRange: { start: 0x10000n, endExclusive: 0x20000n },
    stackAddressRange: { start: 0x20000n, endExclusive: 0x30000n },
    heapAddressRange: { start: 0x30000n, endExclusive: 0x40000n },
  });
  assert.deepEqual(VIRTUAL_HEAP_LAYOUT, {
    ...VIRTUAL_MEMORY_LAYOUT.heapAddressRange,
    alignmentBytes: VIRTUAL_MEMORY_LAYOUT.alignmentBytes,
  });
  assert.deepEqual(CAPABILITIES.virtualMemory.staticAddressRange, {
    start: '0x10000', endExclusive: '0x20000', capacityBytes: 65536,
    allocationPolicy: 'first-fit-persistent',
  });
  assert.deepEqual(CAPABILITIES.virtualMemory.stackAddressRange, {
    start: '0x20000', endExclusive: '0x30000', capacityBytes: 65536,
    allocationPolicy: 'ordered-first-fit-reuse-on-scope-exit',
  });
  assert.equal(CAPABILITIES.virtualMemory.alignmentBytes, 16);
  assert.equal(CAPABILITIES.virtualMemory.guardBytes, 16);
});

test('the allocator reuses released extents without iterating once per reserved slot', () => {
  const location = { file: 'heap-allocator.test.c', line: 1, column: 1 };
  const memory = new VirtualMemory([], null, { peakMemoryBytes: 0 }, () => 0);
  const heapBytes = VIRTUAL_HEAP_LAYOUT.endExclusive - VIRTUAL_HEAP_LAYOUT.start;
  const largeBlock = Number(heapBytes - BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes * 2));
  const first = memory.allocateRaw(largeBlock, location);
  assert.ok(first);
  const firstAddress = memory.describeObject(memory.rootReference(first.allocationId), location).addressVirtual;
  assert.equal(firstAddress, VIRTUAL_HEAP_LAYOUT.start);
  assert.equal(memory.allocateRaw(1, location), null, 'the remaining free slots cannot fit the request and separator');
  assert.equal(memory.allocatedBytes, largeBlock, 'a space failure does not count live bytes');

  memory.free(first, location);
  const replacement = memory.allocateRaw(largeBlock, location);
  assert.ok(replacement);
  const replacementAddress = memory.describeObject(memory.rootReference(replacement.allocationId), location).addressVirtual;
  assert.equal(replacementAddress, firstAddress, 'free releases the interval for a later allocation');
});

test('malloc returns NULL when the virtual heap region is exhausted and emits no phantom allocation', () => {
  const run = runToTerminal(createDebugSession(program('heap-region-exhaustion.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  assert.deepEqual(objects(run.events, 'object-create').filter((event) => event.origin === 'heap'), []);
  assert.deepEqual(objects(run.events, 'object-delete').filter((event) => event.origin === 'heap'), []);
});

test('Static and Stack are independent regions, reserve the guard and reuse Stack when a scope ends', () => {
  const location = { file: 'virtual-memory-layout.test.c', line: 1, column: 1 };
  const bytes = (length) => ({ kind: 'array', element: 'char', length });
  const memory = new VirtualMemory([], null, { peakMemoryBytes: 0 });
  const staticBlock = memory.allocate(bytes(65520), 'static', location);
  const stackBlock = memory.allocate(bytes(1), 'automatic', location);
  const staticAddress = memory.describeObject(staticBlock, location).addressVirtual;
  const firstStackAddress = memory.describeObject(stackBlock, location).addressVirtual;
  assert.equal(staticAddress, VIRTUAL_MEMORY_LAYOUT.staticAddressRange.start);
  assert.equal(firstStackAddress, VIRTUAL_MEMORY_LAYOUT.stackAddressRange.start);
  assert.equal(staticAddress + 65520n, firstStackAddress - BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes),
    'one-past falls before the guard and does not match the first Stack base');
  const onePast = memory.pointerAdd(memory.decay(staticBlock), 65520n, location);
  assert.equal(staticAddress + BigInt(onePast.value.byteOffset), firstStackAddress - 16n);
  assert.equal(memory.allocatedBytes, 65521, 'the guard is not counted as live C bytes');

  assert.throws(() => memory.allocate(bytes(1), 'static', location), (error) =>
    error?.diagnostic?.code === 'STATIC_ADDRESS_SPACE_EXHAUSTED' && error.diagnostic.message.includes('guard'));
  assert.equal(memory.allocatedBytes, 65521, 'a region failure neither publishes nor counts another reservation');

  const staleStackPointer = memory.addressOf(stackBlock);
  memory.release(stackBlock, location);
  const replacement = memory.allocate(bytes(1), 'automatic', location);
  assert.equal(memory.describeObject(replacement, location).addressVirtual, firstStackAddress);
  assert.notEqual(replacement.allocationId, stackBlock.allocationId);
  assert.throws(() => memory.assertAlive(staleStackPointer, location), (error) => error?.diagnostic?.code === 'INACTIVE_OBJECT',
    'reusing an address does not revive the provenance of a removed allocation');

  const stackExhaustion = new VirtualMemory([], null, { peakMemoryBytes: 0 });
  assert.throws(() => stackExhaustion.allocate(bytes(65521), 'automatic', location), (error) =>
    error?.diagnostic?.code === 'STACK_ADDRESS_SPACE_EXHAUSTED' && error.diagnostic.message.includes('Stack'));
  assert.equal(stackExhaustion.allocatedBytes, 0);

  const budgeted = new VirtualMemory([], 64, { peakMemoryBytes: 0 });
  budgeted.allocate(bytes(32), 'static', location);
  budgeted.allocate(bytes(32), 'automatic', location);
  assert.equal(budgeted.allocatedBytes, 64, 'the budget counts C bytes and excludes guards from both regions');
});

test('successive scopes reuse a large virtual stack and preserve allocation provenance', () => {
  const large = runToTerminal(createDebugSession(program('stack-large-reuse.c')));
  assert.equal(large.result.kind, 'terminated', JSON.stringify(large.result));
  assert.equal(large.result.mainReturn, 15);
  const largeCreates = objects(large.events, 'object-create').filter(({ name }) => name === 'first' || name === 'second');
  const largeDeletes = objects(large.events, 'object-delete').filter(({ allocationId }) =>
    largeCreates.some((creation) => creation.allocationId === allocationId));
  assert.equal(largeCreates.length, 2);
  assert.equal(largeDeletes.length, 2);
  assert.equal(largeCreates[0].size, 60000);
  assert.equal(largeCreates[0].addressVirtual, largeCreates[1].addressVirtual,
    'the later scope reuses the large extent released by the previous scope');
  assert.notEqual(largeCreates[0].allocationId, largeCreates[1].allocationId);
  assert.ok(large.events.findIndex((event) => event.kind === 'object-delete' && event.allocationId === largeCreates[0].allocationId) <
    large.events.findIndex((event) => event.kind === 'object-create' && event.allocationId === largeCreates[1].allocationId));

  const stale = runToTerminal(createDebugSession(program('stack-reuse-provenance.c')));
  assert.equal(stale.result.kind, 'runtime-error', JSON.stringify(stale.result));
  assert.equal(stale.result.diagnostics[0].code, 'INACTIVE_OBJECT');
  const values = objects(stale.events, 'object-create').filter(({ name }) => name === 'old_value' || name === 'new_value');
  assert.equal(values.length, 2);
  assert.equal(values[0].addressVirtual, values[1].addressVirtual, 'the previous scope’s address is reused');
  assert.notEqual(values[0].allocationId, values[1].allocationId);
});

test('reusing a heap address does not turn an old pointer copy into the new block', () => {
  const run = runToTerminal(createDebugSession(program('heap-reuse-provenance.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'runtime-error', JSON.stringify(run.result));
  assert.equal(run.result.diagnostics[0].code, 'INACTIVE_OBJECT');
  const created = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  const deleted = objects(run.events, 'object-delete').filter((event) => event.origin === 'heap');
  assert.equal(created.length, 2);
  assert.equal(deleted.length, 1);
  assert.equal(created[0].addressVirtual, deleted[0].addressVirtual);
  assert.equal(created[0].addressVirtual, created[1].addressVirtual, 'seed 0 verifies reuse of the first free slot');
});

test('memcpy preserves a one-past pointer and does not confuse it with another allocation’s base', () => {
  const run = runToTerminal(createDebugSession(program('heap-onepast-provenance.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'runtime-error', JSON.stringify(run.result));
  assert.equal(run.result.diagnostics[0].code, 'POINTER_BOUNDS');
  const created = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  assert.equal(created.length, 2);
  const firstEnd = created[0].addressVirtual + BigInt(created[0].size);
  assert.ok(created[1].addressVirtual > firstEnd, 'the guard separates one-past from the next heap base');
});

test('invalid free and failed malloc produce no false heap events', () => {
  const invalidFree = runToTerminal(createDebugSession(program('invalid-interior-free.c')));
  assert.equal(invalidFree.result.kind, 'runtime-error');
  assert.equal(invalidFree.result.diagnostics[0].code, 'INVALID_FREE');
  assert.equal(objects(invalidFree.events, 'object-create').filter((event) => event.origin === 'heap').length, 1);
  assert.equal(objects(invalidFree.events, 'object-delete').filter((event) => event.origin === 'heap').length, 0);
  assert.deepEqual(objects(invalidFree.events, 'frame-exit'), []);
  assert.deepEqual(objects(invalidFree.events, 'scope-exit'), []);
  assert.deepEqual(objects(invalidFree.events, 'object-delete'), []);

  const allocation = runToTerminal(createDebugSession(
    program('allocation-limit.c'), { limits: { maxMemoryBytes: 8 } },
  ));
  assert.equal(allocation.result.kind, 'limit');
  assert.equal(allocation.result.resource, 'maxMemoryBytes');
  assert.equal(objects(allocation.events, 'object-create').filter((event) => event.origin === 'heap').length, 0);
});

test('realloc publishes a new identity and coherent heap lifecycle even when it keeps the virtual address', () => {
  const session = createDebugSession(program('realloc.c'), undefined, { heapAddressSeed: 0 });
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const created = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  const deleted = objects(run.events, 'object-delete').filter((event) => event.origin === 'heap');
  assert.equal(created.length, 2, 'realloc(NULL, n) and reassignment create blocks');
  assert.equal(deleted.length, 1, 'reassignment removes the previous object');
  assert.equal(deleted[0].allocationId, created[0].allocationId);
  assert.notEqual(created[0].allocationId, created[1].allocationId);
  assert.equal(created[0].size, 4);
  assert.equal(created[1].size, 8);
  assert.equal(created[0].addressVirtual, created[1].addressVirtual, 'growth fits in the reserved extent');
  assert.ok(run.events.findIndex((event) => event.kind === 'object-delete' && event.allocationId === created[0].allocationId) <
    run.events.findIndex((event) => event.kind === 'object-create' && event.allocationId === created[1].allocationId));
  assert.deepEqual(session.inspectHeapObjects(), [{
    id: created[1].allocationId,
    address: `0x${created[1].addressVirtual.toString(16)}`,
    size: 8,
    origin: 'heap',
  }]);
  assertLifecycleOnly(run.events);
});

test('realloc without space preserves the previous block and emits no false heap events', () => {
  const session = createDebugSession(program('realloc-failure.c'), undefined, { heapAddressSeed: 0 });
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  assert.equal(objects(run.events, 'object-create').filter((event) => event.origin === 'heap').length, 1);
  assert.equal(objects(run.events, 'object-delete').filter((event) => event.origin === 'heap').length, 0);
  assert.equal(session.inspectHeapObjects().length, 1);
  assert.equal(session.inspectHeapObjects()[0].size, 4);
  assertLifecycleOnly(run.events);
});

test('realloc moves around a neighbor, preserves data, emits delete/create and releases the previous extent', () => {
  const run = runToTerminal(createDebugSession(program('realloc-move.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const created = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  const deleted = objects(run.events, 'object-delete').filter((event) => event.origin === 'heap');
  assert.equal(created.length, 4);
  assert.equal(deleted.length, 4);
  assert.equal(created[1].addressVirtual, created[0].addressVirtual + 32n,
    'the second block occupies the next extent and prevents in-place growth');
  assert.equal(created[2].size, 40);
  assert.notEqual(created[2].addressVirtual, created[0].addressVirtual,
    'realloc must reserve another extent when a neighbor prevents growth');
  assert.equal(created[3].addressVirtual, created[0].addressVirtual,
    'a new reservation reuses the old extent’s address');
  assert.equal(deleted[0].allocationId, created[0].allocationId);
  assert.notEqual(created[2].allocationId, created[0].allocationId);
  assert.ok(run.events.findIndex((event) => event.kind === 'object-delete' && event.allocationId === created[0].allocationId) <
    run.events.findIndex((event) => event.kind === 'object-create' && event.allocationId === created[2].allocationId));
  assertLifecycleOnly(run.events);
});

test('realloc does not restore truncated pointer provenance when the missing byte is written back', () => {
  const at = { file: 'realloc-provenance.test.c', line: 1, column: 1 };
  const memory = new VirtualMemory([], null, { peakMemoryBytes: 0 }, () => 0);
  const target = memory.allocateRaw(4, at);
  const slot = memory.allocateRaw(8, at);
  assert.ok(target);
  assert.ok(slot);

  const pointerType = pointerTo('int');
  const slotType = pointerTo(pointerType);
  const slotReference = memory.dereference({ type: slotType, value: slot }, at);
  memory.write(slotReference, { type: pointerType, value: target }, at);
  assert.equal(memory.copyablePointerValues(slot, 8, at).length, 1);

  const byteType = pointerTo('unsigned char');
  const lastByteReference = memory.dereference(memory.pointerAdd({ type: byteType, value: slot }, 7n, at), at);
  const lastByte = memory.read(lastByteReference, at);
  const truncated = memory.reallocateRaw(slot, 7, at);
  assert.ok(truncated);
  assert.equal(memory.copyablePointerValues(truncated, 7, at).length, 0);

  const expanded = memory.reallocateRaw(truncated, 8, at);
  assert.ok(expanded);
  const restoredByteReference = memory.dereference(memory.pointerAdd({ type: byteType, value: expanded }, 7n, at), at);
  memory.write(restoredByteReference, lastByte, at);
  assert.equal(memory.copyablePointerValues(expanded, 8, at).length, 0);

  const restoredSlot = memory.dereference({ type: slotType, value: expanded }, at);
  const inspected = memory.inspectPointer(restoredSlot, at);
  assert.equal(inspected.initialized, true);
  assert.equal(inspected.status, 'unmapped');
  assert.equal(inspected.target, undefined, 'the eight bytes do not reconstruct the original pointer identity');
});

test('debug runs stdio on stdin and virtual files and preserves return values, errno and output', () => {
  const source = `#include <errno.h>
#include <stdio.h>
int main(void) {
  int prompt = printf("in: ");
  int value = 0;
  int scanned = scanf("%d", &value);
  FILE *file = fopen("data.bin", "r+");
  int wrote = fputc('Z', file);
  int reset = fseek(file, 0, 0);
  int first = fgetc(file);
  int second = fgetc(file);
  int bad_seek = fseek(file, -1, 0);
  int seek_error = errno;
  int had_error = ferror(file);
  clearerr(file);
  int cleared_error = !ferror(file);
  errno = 0;
  FILE *missing = fopen("missing.bin", "r");
  int missing_error = errno;
  int reported = fprintf(stderr, "missing=%d bytes=%c%c\\n", missing_error, first, second);
  int closed = fclose(file);
  return prompt == 4 && scanned == 1 && value == 19 && file != NULL && wrote == 'Z' &&
      reset == 0 && first == 'Z' && second == 'B' && bad_seek == -1 && seek_error != 0 &&
      had_error && cleared_error && missing == NULL &&
      missing_error != 0 && reported == 19 && closed == 0 ? 0 : 1;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-stdio-virtual.c',
    files: [{ name: 'debug-stdio-virtual.c', source }],
  });
  const session = createDebugSession(prepared, {
    io: { stdin: '19\n', files: [{ name: 'data.bin', data: 'AB' }] },
  });
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  assert.equal(decodeBytes(run.result.stdout), 'in: ');
  assert.equal(decodeBytes(run.result.stderr), 'missing=2 bytes=ZB\n');
  assert.ok(run.steps.some((step) => step.kind === 'paused' && decodeBytes(step.stdout) === 'in: '));
  assertLifecycleOnly(run.events);
});

test('debug publishes the prompt, partially suspends scanf and resumes the same visit without repeating &a[i++]', () => {
  const source = `#include <stdio.h>
int main(void) {
  int values[2] = { 0, 0 };
  int index = 0;
  int second = 0;
  printf("Numbers: ");
  int converted = scanf("%d %d", &values[index++], &second);
  int valid = converted == 2 && index == 1 && values[0] == 12 && second == 34;
  return valid ? 0 : 1;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-stdio-suspend.c',
    files: [{ name: 'debug-stdio-suspend.c', source }],
  });
  const session = createDebugSession(prepared, { io: { stdin: '12 ' } });
  const waiting = advanceToInputNeeded(session);
  const scanfLine = source.split('\n').findIndex((line) => line.includes('scanf(')) + 1;
  const nextLine = source.split('\n').findIndex((line) => line.includes('int valid')) + 1;
  assert.equal(waiting.location.file, 'debug-stdio-suspend.c');
  assert.equal(waiting.location.line, scanfLine);
  assert.ok(waiting.location.column > 0);
  assert.equal(decodeBytes(waiting.stdout), 'Numbers: ');
  assert.deepEqual(waiting.stderr, new Uint8Array());
  assert.equal(session.inspectScalars().find((scalar) => scalar.name === 'index')?.displayValue, '1');
  const stored = session.inspectArrays().arrays.find((array) => array.name === 'values');
  assert.equal(stored.elements[0].displayValue, '12');
  assert.equal(stored.elements[1].displayValue, '0');

  const stillWaiting = session.resume();
  assert.equal(stillWaiting.kind, 'input-needed');
  assert.deepEqual(stillWaiting.location, waiting.location);
  assert.equal(session.inspectScalars().find((scalar) => scalar.name === 'index')?.displayValue, '1');

  session.appendStdin(new TextEncoder().encode('34\n'));
  const continued = session.resume();
  assert.equal(continued.kind, 'paused', JSON.stringify(continued));
  assert.equal(continued.location.line, nextLine, 'continuation stops before the next line’s instruction');
  assert.equal(decodeBytes(continued.stdout), 'Numbers: ');
  assert.equal(session.inspectScalars().find((scalar) => scalar.name === 'index')?.displayValue, '1');
  const completed = session.inspectArrays().arrays.find((array) => array.name === 'values');
  assert.equal(completed.elements[0].displayValue, '12');
  assert.equal(completed.elements[1].displayValue, '0');

  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
});

test('debug preserves partial fgets and fread through sticky EOF without re-executing the line', () => {
  const source = `#include <stdio.h>
int main(void) {
  char line[8] = { 0 };
  char *line_result = fgets(line, sizeof line, stdin);
  unsigned char rest[4] = { 0 };
  size_t read_count = fread(rest, 1, sizeof rest, stdin);
  int at_eof = feof(stdin);
  int again = getchar();
  return line_result == line && line[0] == 'a' && line[1] == 'b' && line[2] == 'c' &&
      line[3] == '\\n' && line[4] == 0 && read_count == 2 && rest[0] == 'x' && rest[1] == 'y' &&
      at_eof && again == EOF && feof(stdin) ? 0 : 1;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-stdio-eof.c',
    files: [{ name: 'debug-stdio-eof.c', source }],
  });
  const session = createDebugSession(prepared, { io: { stdin: 'abc' } });
  const lineWaiting = advanceToInputNeeded(session);
  assert.equal(lineWaiting.location.line, source.split('\n').findIndex((line) => line.includes('fgets(')) + 1);
  session.appendStdin(new TextEncoder().encode('\nxy'));
  const beforeFread = session.resume();
  assert.equal(beforeFread.kind, 'paused', JSON.stringify(beforeFread));
  const freadLine = source.split('\n').findIndex((line) => line.includes('fread(')) + 1;
  const restDeclarationLine = source.split('\n').findIndex((line) => line.includes('unsigned char rest')) + 1;
  assert.equal(beforeFread.location.line, restDeclarationLine);
  const beforeRead = session.resume();
  assert.equal(beforeRead.kind, 'paused', JSON.stringify(beforeRead));
  assert.equal(beforeRead.location.line, freadLine);

  const freadWaiting = session.resume();
  assert.equal(freadWaiting.kind, 'input-needed');
  assert.equal(freadWaiting.location.line, freadLine);
  session.endStdin();
  const afterFread = session.resume();
  assert.equal(afterFread.kind, 'paused', JSON.stringify(afterFread));
  assert.equal(afterFread.location.line, source.split('\n').findIndex((line) => line.includes('int at_eof')) + 1);
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
});

test('debug shares maxIOBytes and preserves stdout and stderr snapshots when limited', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-stdio-limit.c',
    files: [{
      name: 'debug-stdio-limit.c',
      source: '#include <stdio.h>\nint main(void) { fprintf(stderr, "E"); printf("> "); int value = 0; scanf("%d", &value); return 0; }',
    }],
  });
  const session = createDebugSession(prepared, { limits: { maxIOBytes: 3 } });
  const waiting = advanceToInputNeeded(session);
  assert.equal(decodeBytes(waiting.stdout), '> ');
  assert.equal(decodeBytes(waiting.stderr), 'E');

  session.appendStdin(new TextEncoder().encode('7\n'));
  const limited = session.resume();
  assert.equal(limited.kind, 'limit', JSON.stringify(limited));
  assert.equal(limited.resource, 'maxIOBytes');
  assert.equal(decodeBytes(limited.stdout), '> ');
  assert.equal(decodeBytes(limited.stderr), 'E');
});

test('event limits preserve a prefix and do not mutate memory after exhaustion', () => {
  const prepared = program('debug-heap-first-line.c');
  const baseline = createDebugSession(prepared);
  const setupEvents = baseline.drainEvents();
  assert.ok(setupEvents.length > 0);

  const session = createDebugSession(prepared, undefined, { maxEvents: setupEvents.length });
  const initialEvents = session.drainEvents();
  assert.equal(initialEvents.length, setupEvents.length);
  const first = session.resume();
  const firstEvents = session.drainEvents();
  assert.equal(first.kind, 'debug-limit', JSON.stringify(first));
  assert.equal(first.resource, 'maxDebugEvents');
  assert.equal(first.limit, setupEvents.length);
  assert.equal(initialEvents.length + firstEvents.length, setupEvents.length);
  assert.equal(objects([...initialEvents, ...firstEvents], 'object-create').filter((event) => event.origin === 'heap').length, 0);

  const second = session.resume();
  assert.equal(second.kind, 'debug-limit');
  assert.deepEqual(session.drainEvents(), []);
  assert.equal(second.metrics.instructionCount, first.metrics.instructionCount);
  assert.equal(second.metrics.peakMemoryBytes, first.metrics.peakMemoryBytes);
  assertLifecycleOnly([...initialEvents, ...firstEvents]);
});

test('the event limit reserves parameter publication before writing its argument', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-parameter-event-budget.c',
    files: [{ name: 'debug-parameter-event-budget.c', source: `int echo(int value) {
  return value;
}
int main(void) {
  return echo(42);
}` }],
  });
  const baseline = createDebugSession(prepared);
  const setupEvents = baseline.drainEvents();
  const setupFrame = objects(setupEvents, 'frame-enter').find((event) => event.functionName === 'main');
  assert.ok(setupFrame);

  const beforeParameterCreate = createDebugSession(prepared, undefined, { maxEvents: setupEvents.length + 2 });
  const prefix = [...beforeParameterCreate.drainEvents()];
  let result;
  for (let index = 0; index < 10; index += 1) {
    result = beforeParameterCreate.resume();
    prefix.push(...beforeParameterCreate.drainEvents());
    if (result.kind !== 'paused') break;
  }
  assert.equal(result?.kind, 'debug-limit');
  assert.equal(prefix.length, setupEvents.length + 2);
  const pendingFrame = objects(prefix, 'frame-enter').find((event) => event.functionName === 'echo');
  const pendingScope = objects(prefix, 'scope-enter').find((event) => event.frameId === pendingFrame?.frameId);
  assert.ok(pendingFrame && pendingScope, 'the confirmed prefix entering the frame and scope is preserved');
  assert.equal(objects(prefix, 'object-create').some((event) => event.name === 'value'), false);
  assert.equal(beforeParameterCreate.inspectScalars().some((scalar) => scalar.name === 'value'), false);

  const afterParameterCreate = createDebugSession(prepared, undefined, { maxEvents: setupEvents.length + 3 });
  const run = runToTerminal(afterParameterCreate);
  assert.equal(run.result.kind, 'debug-limit');
  const parameterCreate = objects(run.events, 'object-create').find((event) => event.name === 'value');
  assert.ok(parameterCreate, 'the budget confirms the parameter object-create event before exhaustion');
  assert.equal(parameterCreate.origin, 'parameter');
  assert.deepEqual(afterParameterCreate.inspectScalars().map((scalar) => ({ name: scalar.name, origin: scalar.origin, initialized: scalar.initialized, displayValue: scalar.displayValue })), [
    { name: 'value', origin: 'parameter', initialized: true, displayValue: '42' },
  ]);
});

test('explicit null debug options produce a diagnostic', () => {
  const session = createDebugSession(program('recursion-frames.c'), undefined, null);
  const result = session.resume();
  assert.equal(result.kind, 'runtime-error');
  assert.equal(result.diagnostics[0].code, 'INVALID_OPTIONS');
  assert.deepEqual(session.drainEvents(), []);
});

test('the instruction limit does not fabricate scope or frame exits', () => {
  const run = runToTerminal(createDebugSession(
    program('instruction-limit.c'), { limits: { maxInstructions: 6 } },
  ));
  assert.equal(run.result.kind, 'limit');
  assert.equal(run.result.resource, 'maxInstructions');
  assert.ok(objects(run.events, 'frame-enter').length > 0);
  assert.ok(objects(run.events, 'scope-enter').length > 0);
  assert.deepEqual(objects(run.events, 'frame-exit'), []);
  assert.deepEqual(objects(run.events, 'scope-exit'), []);
  assert.deepEqual(objects(run.events, 'object-delete'), []);
});

test('debug preserves initial argv and stdin, and the normal session keeps its interactive contract', () => {
  const argvProgram = prepareProject(prepare, {
    entry: 'debug-argv.c',
    files: [{
      name: 'debug-argv.c',
      source: 'int main(int argc, char **argv) { return argc == 2 && argv[1][0] == \'x\' ? 0 : 1; }',
    }],
  });
  const argvRun = runToTerminal(createDebugSession(argvProgram, {
    io: { argv: ['demo', 'x'], stdin: 'ignored\n' },
  }));
  assert.equal(argvRun.result.kind, 'terminated');
  assert.equal(argvRun.result.mainReturn, 0);

  const prepared = program('interactive-input.c');
  const debug = createDebugSession(prepared, { io: { stdin: '21\n' } });
  assert.equal(typeof debug.appendStdin, 'function');
  assert.equal(typeof debug.endStdin, 'function');
  const debugRun = runToTerminal(debug);
  assert.equal(debugRun.result.kind, 'terminated', JSON.stringify(debugRun.result));
  assert.equal(debugRun.result.mainReturn, 0);
  assert.deepEqual(debugRun.result.stdout, new Uint8Array());
  assert.deepEqual(debugRun.result.stderr, new Uint8Array());
  assert.ok(!debugRun.steps.some((step) => step.kind === 'input-needed'));

  const normal = createExecutionSession(prepared);
  const waiting = normal.resume();
  assert.equal(waiting.kind, 'input-needed');
  normal.appendStdin(new TextEncoder().encode('21\n'));
  const finished = normal.resume();
  assert.equal(finished.kind, 'terminated', JSON.stringify(finished));
  const batch = execute(prepared, { io: { stdin: '21\n' } });
  assert.equal(batch.kind, 'terminated');
  assert.equal(batch.mainReturn, finished.mainReturn);
  assert.equal(batch.metrics.instructionCount, finished.metrics.instructionCount);
  assert.equal(batch.metrics.peakMemoryBytes, finished.metrics.peakMemoryBytes);
});

test('instrumentation preserves metrics, and the normal session exposes no events', () => {
  const prepared = program('lifecycle-roots-scopes.c');
  const normal = execute(prepared);
  const debugSession = createDebugSession(prepared);
  const debug = runToTerminal(debugSession).result;
  assert.equal(normal.kind, 'terminated');
  assert.equal(debug.kind, 'terminated');
  assert.equal(normal.mainReturn, debug.mainReturn);
  assert.equal(normal.metrics.instructionCount, debug.metrics.instructionCount);
  assert.equal(normal.metrics.peakMemoryBytes, debug.metrics.peakMemoryBytes);
  assert.equal(typeof debugSession.drainEvents, 'function');
  const ordinarySession = createExecutionSession(prepared);
  assert.equal('drainEvents' in ordinarySession, false);
  assert.equal('inspectScalars' in ordinarySession, false);
  assert.equal('inspectStaticObjects' in ordinarySession, false);
  assert.equal('inspectArrays' in ordinarySession, false);
});

test('memory roots preserve identity, duration and location', () => {
  const prepared = program('lifecycle-roots-scopes.c');
  const session = createDebugSession(prepared);
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);

  const events = run.events;
  assert.deepEqual(session.drainEvents(), []);
  assert.deepEqual(structuredClone(events), events);
  const created = objects(events, 'object-create');
  const deleted = objects(events, 'object-delete');
  assert.deepEqual(new Set(created.map((event) => event.name).filter(Boolean)), new Set([
    'global_cell', 'result', 'local_cell', 'samples', 'temporary',
  ]));
  assert.equal(created.length, 6);
  assert.equal(deleted.length, 5);
  assert.ok(created.every((event) => event.objectId === event.allocationId));
  assert.equal(new Set(created.map((event) => event.allocationId)).size, created.length);

  const byName = new Map(created.filter((event) => event.name).map((event) => [event.name, event]));
  assert.equal(byName.get('global_cell').duration, 'static');
  assert.equal(byName.get('local_cell').duration, 'automatic');
  assert.equal(byName.get('global_cell').location.line, 6);
  assert.equal(byName.get('local_cell').location.line, 11);
  assert.equal(byName.get('local_cell').typeSummary, 'struct Cell');
  assert.equal(byName.get('samples').typeSummary, 'int[3]');
  assert.equal(byName.get('samples').size, 12);
  const compound = created.find((event) => event.origin === 'compound-literal' && event.typeSummary === 'struct Cell');
  assert.ok(compound);
  const rangesByDuration = {
    static: VIRTUAL_MEMORY_LAYOUT.staticAddressRange,
    'string-literal': VIRTUAL_MEMORY_LAYOUT.staticAddressRange,
    automatic: VIRTUAL_MEMORY_LAYOUT.stackAddressRange,
    'compound-literal': VIRTUAL_MEMORY_LAYOUT.stackAddressRange,
    heap: VIRTUAL_MEMORY_LAYOUT.heapAddressRange,
  };
  const liveAddresses = new Map();
  for (const event of events) {
    if (event.kind === 'object-create') {
      const range = rangesByDuration[event.duration];
      assert.ok(range, `known duration: ${event.duration}`);
      assert.ok(event.addressVirtual >= range.start);
      assert.ok(event.addressVirtual + BigInt(event.size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) <= range.endExclusive,
        'the object and its guard remain within their region');
      assert.equal(event.addressVirtual % BigInt(VIRTUAL_MEMORY_LAYOUT.alignmentBytes), 0n);
      for (const prior of liveAddresses.values()) {
        const priorEnd = prior.address + BigInt(prior.size);
        const eventEnd = event.addressVirtual + BigInt(event.size);
        assert.ok(priorEnd + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) <= event.addressVirtual ||
          eventEnd + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) <= prior.address,
        'live objects do not overlap, and the guard separates one-past from a neighboring base');
      }
      liveAddresses.set(event.allocationId, { address: event.addressVirtual, size: event.size });
    } else if (event.kind === 'object-delete') {
      assert.ok(liveAddresses.delete(event.allocationId), 'deletion corresponds to a live object');
    }
  }
  assert.ok(created.every((event) => event.location.line > 0 && event.location.column > 0));

  const globalId = byName.get('global_cell').allocationId;
  assert.ok(!deleted.some((event) => event.allocationId === globalId));
  assert.deepEqual(
    new Set(deleted.map((event) => event.allocationId)),
    new Set(created.filter((event) => event.allocationId !== globalId).map((event) => event.allocationId)),
  );
  const createsById = new Map(created.map((event) => [event.allocationId, event]));
  for (const deletion of deleted) {
    const creation = createsById.get(deletion.allocationId);
    assert.ok(creation);
    assert.equal(deletion.frameId, creation.frameId);
    assert.equal(deletion.scopeId, creation.scopeId);
    assert.equal(deletion.addressVirtual, creation.addressVirtual);
    assert.equal(deletion.size, creation.size);
  }
  const enteredFrames = new Set(objects(events, 'frame-enter').map((event) => event.frameId));
  const enteredScopes = new Set(objects(events, 'scope-enter').map((event) => event.scopeId));
  for (const object of created.filter((event) => event.duration === 'automatic' || event.duration === 'compound-literal')) {
    assert.ok(enteredFrames.has(object.frameId));
    assert.ok(enteredScopes.has(object.scopeId));
  }
  assert.equal(events.filter((event) => event.kind.startsWith('scope-')).length, 4);
  assert.equal(events.filter((event) => event.kind.startsWith('frame-')).length, 2);
  assert.ok(events.every((event) => event.location.file === 'lifecycle-roots-scopes.c'));
  assertLifecycleOnly(events);
});

test('the debug session inspects live automatic scalars without reading uninitialized values', () => {
  assert.deepEqual(CAPABILITIES.debugSession.values, {
    liveAutomaticScalars: true,
    liveStaticScalars: true,
    stringLiteralContents: true,
    liveHeapAllocations: true,
    oneDimensionalArithmeticArrays: 'bounded-by-debug-session-options',
    oneDimensionalPointerArrays: 'bounded-by-debug-session-options-and-default-array-cell-maximum; direct-pointer-status-and-target-identity',
    stringLiteralCharacters: 'bounded-by-debug-session-options',
      aggregates: 'bounded-direct-struct-members; unions-opaque',
    pointers: 'basic-identity-aware-binding-snapshots',
      pointerTargetResolution: 'allocation-identity-and-byte-offset-for-bounded-array-cells-and-struct-members',
  });
  assert.equal(CAPABILITIES.debugSession.automaticObjectPublication, 'declaration-execution');
  assert.equal(CAPABILITIES.debugSession.externalIO, 'virtual-stdio');
  assert.equal(CAPABILITIES.debugSession.interactiveStdin, true);
  assert.equal(CAPABILITIES.debugSession.outputSnapshots, 'cumulative-per-progress');
  assert.deepEqual(CAPABILITIES.debugSession.objectOrigins, ['variable', 'parameter', 'compound-literal', 'heap', 'string-literal']);
  const prepared = program('scalar-inspection.c');
  const session = createDebugSession(prepared);
  const initialEvents = [...session.drainEvents()];
  const creates = objects(initialEvents, 'object-create');
  const firstLocation = session.currentLocation();
  const before = session.inspectScalars();
  assert.deepEqual(before, [], 'main already has an active scope, but no local declaration has executed');
  assert.equal(creates.some((event) => event.duration === 'automatic'), false);
  assert.deepEqual(session.currentLocation(), firstLocation, 'inspection does not advance the VM');
  assert.deepEqual(session.drainEvents(), [], 'inspection does not generate events');
  assert.deepEqual(structuredClone(before), before, 'DTOs are serializable');

  const observations = [];
  const events = initialEvents.slice();
  for (let index = 0; index < 100; index += 1) {
    const progress = session.resume();
    const emitted = session.drainEvents();
    events.push(...emitted);
    const scalars = session.inspectScalars();
    observations.push({ progress, location: session.currentLocation(), scalars, emitted });
    if (progress.kind !== 'paused') break;
  }
  assert.equal(observations.at(-1)?.progress.kind, 'terminated');
  const all = observations.flatMap((observation) => observation.scalars);
  const allCreates = objects(events, 'object-create');
  const createById = new Map(allCreates.map((event) => [event.allocationId, event]));
  for (const scalar of all) {
    const created = createById.get(scalar.id);
    assert.ok(created, `${scalar.name} shares an ID with its actual object-create event`);
    assert.equal(created.scopeId, scalar.scopeId);
    assert.equal(created.frameId, scalar.frameId);
    assert.equal(created.origin, scalar.origin);
    assert.equal(scalar.address, `0x${created.addressVirtual.toString(16)}`);
    assert.equal(scalar.size, created.size);
  }
  assert.deepEqual(objects(observations[0].emitted, 'object-create').map((event) => event.name), ['long_value']);
  assert.deepEqual(observations[0].scalars.map((scalar) => [scalar.name, scalar.initialized, scalar.displayValue]), [
    ['long_value', true, '9007199254740993'],
  ]);
  const hasValue = (name, type, value) => all.some((scalar) => scalar.name === name && scalar.type === type && scalar.displayValue === value);
  assert.ok(hasValue('long_value', 'long', '9007199254740993'));
  assert.ok(hasValue('very_long', 'long long', '-9223372036854775808'));
  assert.ok(hasValue('unsigned_value', 'unsigned long long', '18446744073709551615'));
  assert.ok(hasValue('active', '_Bool', '1'));
  assert.ok(hasValue('letter', 'char', "'C'"));
  assert.ok(hasValue('newline', 'char', "'\\n'"));
  assert.ok(hasValue('short_value', 'short', '-1234'));
  assert.ok(hasValue('decimal_value', 'float', '3.5'));
  assert.ok(hasValue('precision_value', 'double', '2.718281828459045'));
  assert.ok(hasValue('negative_zero', 'double', '-0'));
  assert.ok(hasValue('status', 'enum Status', '4'), 'the snapshot preserves the enum type and its int representation');
  assert.ok(all.filter((scalar) => scalar.name === 'uninitialized').every((scalar) => !scalar.initialized && scalar.displayValue === '?'));
  assert.ok(all.some((scalar) => scalar.name === 'mutable' && scalar.displayValue === '1'));
  assert.ok(all.some((scalar) => scalar.name === 'mutable' && scalar.displayValue === '2'), 'the later assignment is reflected without a write event');

  const temporary = all.find((scalar) => scalar.name === 'temporary');
  assert.ok(temporary);
  const laterSnapshots = observations.slice(observations.findIndex((item) => item.scalars.some((scalar) => scalar.id === temporary.id)) + 1);
  assert.ok(laterSnapshots.some((item) => !item.scalars.some((scalar) => scalar.id === temporary.id)), 'the value disappears when its scope closes');
  assert.ok(all.some((scalar) => scalar.name === 'parameter' && scalar.displayValue === '2'));
  assert.ok(all.some((scalar) => scalar.name === 'parameter' && scalar.origin === 'parameter'));
  assert.ok(all.some((scalar) => scalar.name === 'local' && scalar.displayValue === '2'));
  assert.ok(all.some((scalar) => scalar.name === 'local' && scalar.origin === 'variable'));
  assert.ok(all.some((scalar) => scalar.name === 'local' && scalar.displayValue === '3'));
  const adjustFrame = objects(events, 'frame-enter').find((event) => event.functionName === 'adjust');
  const adjustScope = objects(events, 'scope-enter').find((event) => event.frameId === adjustFrame.frameId);
  const parameterCreate = allCreates.find((event) => event.name === 'parameter');
  const firstLocalCreate = allCreates.find((event) => event.name === 'local');
  assert.ok(adjustFrame.sequence < adjustScope.sequence && adjustScope.sequence < parameterCreate.sequence);
  assert.ok(parameterCreate.sequence < firstLocalCreate.sequence, 'the parameter is published on entry, before the first local declaration');
  assert.equal(parameterCreate.origin, 'parameter');
  assert.equal(firstLocalCreate.origin, 'variable');
  assert.equal(parameterCreate.frameId, adjustFrame.frameId);
  assert.deepEqual(session.inspectScalars(), [], 'normal return closes scopes and their objects');
  assert.equal(session.currentLocation(), null);
});

test('debug snapshots show exact binary80 in scalars, arrays and serializable fields', () => {
  const session = createDebugSession(program('long-double-values.c'));
  const pause = pauseBeforeLine(session, 14);
  assert.equal(pause.kind, 'paused');

  const scalars = session.inspectScalars();
  const arrays = session.inspectArrays();
  const aggregates = session.inspectAggregates();
  const precise = '0x1.0000000000000002p+0';
  const negativeZero = '-0x0p+0';
  assert.equal(scalars.find((scalar) => scalar.name === 'precise')?.displayValue, precise);
  assert.equal(scalars.find((scalar) => scalar.name === 'negative_zero')?.displayValue, negativeZero);
  assert.deepEqual(arrays.arrays.find((array) => array.name === 'values')?.elements.map(({ displayValue }) => displayValue), [
    precise, negativeZero,
  ]);
  assert.equal(aggregates.aggregates.find((aggregate) => aggregate.name === 'box')?.members
    .find((member) => member.name === 'precise')?.displayValue, precise);
  const snapshots = { scalars, arrays, aggregates };
  assert.deepEqual(JSON.parse(JSON.stringify(snapshots)), snapshots,
    'DTOs publish binary80 as text without leaking nonserializable internal values');
});

test('recursive parameters preserve origin, frame and scope until each activation returns', () => {
  const session = createDebugSession(program('recursion-frames.c'));
  const events = [...session.drainEvents()];
  const snapshots = [];
  for (let index = 0; index < 100; index += 1) {
    const progress = session.resume();
    events.push(...session.drainEvents());
    snapshots.push(session.inspectScalars());
    if (progress.kind !== 'paused') {
      assert.equal(progress.kind, 'terminated', JSON.stringify(progress));
      break;
    }
  }

  const deepest = snapshots.find((snapshot) => snapshot.filter((scalar) => scalar.name === 'remaining').length === 4 &&
    snapshot.filter((scalar) => scalar.name === 'saved').length === 4);
  assert.ok(deepest, 'all four recursive activations are observed at once');
  const parameters = deepest.filter((scalar) => scalar.name === 'remaining');
  const locals = deepest.filter((scalar) => scalar.name === 'saved');
  assert.equal(new Set(parameters.map((scalar) => scalar.frameId)).size, 4);
  assert.equal(new Set(parameters.map((scalar) => scalar.scopeId)).size, 4);
  assert.equal(new Set(parameters.map((scalar) => scalar.id)).size, 4);
  assert.deepEqual(parameters.map((scalar) => scalar.origin), ['parameter', 'parameter', 'parameter', 'parameter']);
  assert.deepEqual(locals.map((scalar) => scalar.origin), ['variable', 'variable', 'variable', 'variable']);
  for (const parameter of parameters) {
    const local = locals.find((scalar) => scalar.frameId === parameter.frameId);
    assert.ok(local, `the local variable shares activation ${parameter.frameId}`);
    assert.equal(local.scopeId, parameter.scopeId, 'the parameter and local share the function’s root scope');
    assert.notEqual(local.id, parameter.id);
    assert.notEqual(local.address, parameter.address);
  }
  assert.equal(new Set(deepest.map((scalar) => scalar.id)).size, deepest.length, 'live cells do not alias their allocations');
  assert.equal(new Set(deepest.map((scalar) => scalar.address)).size, deepest.length, 'live cells have distinct addresses');

  const creates = objects(events, 'object-create');
  const deletes = new Map(objects(events, 'object-delete').map((event) => [event.allocationId, event]));
  const scopesById = new Map(objects(events, 'scope-enter').map((event) => [event.scopeId, event]));
  for (const scalar of deepest) {
    const created = creates.find((event) => event.allocationId === scalar.id);
    assert.ok(created);
    assert.equal(created.origin, scalar.origin);
    assert.equal(created.scopeId, scalar.scopeId);
    assert.equal(created.frameId, scalar.frameId);
    const scope = scopesById.get(scalar.scopeId);
    assert.equal(scope?.frameId, scalar.frameId);
    if (scalar.name === 'remaining' || scalar.name === 'saved') assert.equal(scope?.scopeName, 'descend');
  }
  for (const created of creates) {
    const deleted = deletes.get(created.allocationId);
    assert.ok(deleted, `return removes ${created.name} from its activation`);
    assert.equal(deleted.frameId, created.frameId);
    assert.equal(deleted.scopeId, created.scopeId);
    assert.equal(deleted.origin, created.origin);
  }
  assert.deepEqual(session.inspectScalars(), [], 'all activations and parameters disappear on return');
});

test('inspection preserves live objects after an error and does not invent unwinds', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-inspection-error.c',
    files: [{ name: 'debug-inspection-error.c', source: 'int main(void) {\n  int keep = 7;\n  int broken = 1 / 0;\n  return 0;\n}\n' }],
  });
  const session = createDebugSession(prepared);
  let progress;
  do { progress = session.resume(); } while (progress.kind === 'paused');
  assert.equal(progress.kind, 'runtime-error');
  assert.deepEqual(session.inspectScalars().map(({ name, initialized, displayValue }) => ({ name, initialized, displayValue })), [
    { name: 'keep', initialized: true, displayValue: '7' },
    { name: 'broken', initialized: false, displayValue: '?' },
  ]);
  const events = session.drainEvents();
  assert.deepEqual(objects(events, 'object-create').map((event) => event.name), ['keep', 'broken']);
  assert.deepEqual(objects(events, 'object-delete'), [], 'an error does not remove live objects');
  assert.equal(objects(events, 'scope-exit').length, 0, 'an error does not synthesize exits');
});

test('inspectPointers separates an object’s own address from its value, observes NULL and performs no C reads', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointers-basic.c',
    files: [{ name: 'debug-pointers-basic.c', source: `int *global_pointer;
int main(void) {
  int n = 1;
  int other = 2;
  int *p;
  p = &n;
  *p = 9;
  p = &other;
  p = 0;
  return n == 9 && other == 2 ? 0 : 1;
}
` }],
  });
  const session = createDebugSession(prepared);
  const global = session.inspectPointers().find((pointer) => pointer.name === 'global_pointer');
  assert.ok(global);
  assert.equal(global.status, 'null');
  assert.equal(global.displayValue, '0x0');
  assert.equal(global.initialized, true);
  assert.equal(global.frameId, null);
  assert.equal(global.scopeId, null);

  assert.equal(pauseBeforeLine(session, 6).kind, 'paused');
  const uninitialized = session.inspectPointers().find((pointer) => pointer.name === 'p');
  assert.ok(uninitialized);
  assert.equal(uninitialized.initialized, false);
  assert.equal(uninitialized.status, 'uninitialized');
  assert.equal(uninitialized.displayValue, '?');
  const stableLocation = session.currentLocation();
  session.drainEvents();
  const repeated = session.inspectPointers();
  assert.deepEqual(session.inspectPointers(), repeated);
  assert.deepEqual(session.currentLocation(), stableLocation);
  assert.deepEqual(session.drainEvents(), [], 'inspection does not generate events');
  assert.equal(Object.isFrozen(repeated), true);
  assert.equal(Object.isFrozen(uninitialized), true);
  assert.deepEqual(structuredClone(repeated), repeated, 'snapshots serialize without converting addresses to Number');

  assert.equal(pauseBeforeLine(session, 7).kind, 'paused');
  const pointsToN = session.inspectPointers().find((pointer) => pointer.name === 'p');
  const n = session.inspectScalars().find((scalar) => scalar.name === 'n');
  assert.ok(pointsToN && n);
  assert.equal(pointsToN.status, 'live');
  assert.equal(pointsToN.initialized, true);
  assert.equal(pointsToN.displayValue, n.address);
  assert.equal(pointsToN.target?.name, 'n');
  assert.equal(pointsToN.target?.allocationId, n.id);
  assert.equal(Object.isFrozen(pointsToN.target), true);

  assert.equal(pauseBeforeLine(session, 8).kind, 'paused');
  const afterIndirectWrite = session.inspectPointers().find((pointer) => pointer.name === 'p');
  assert.deepEqual(afterIndirectWrite, pointsToN, 'writing *p does not change identity or produce a target value');
  assert.equal(session.inspectScalars().find((scalar) => scalar.name === 'n')?.displayValue, '9');

  assert.equal(pauseBeforeLine(session, 9).kind, 'paused');
  const pointsToOther = session.inspectPointers().find((pointer) => pointer.name === 'p');
  const other = session.inspectScalars().find((scalar) => scalar.name === 'other');
  assert.ok(pointsToOther && other);
  assert.equal(pointsToOther.id, pointsToN.id);
  assert.equal(pointsToOther.address, pointsToN.address, 'p’s address does not depend on its value');
  assert.equal(pointsToOther.displayValue, other.address);
  assert.equal(pointsToOther.target?.name, 'other');

  assert.equal(pauseBeforeLine(session, 10).kind, 'paused');
  const nullPointer = session.inspectPointers().find((pointer) => pointer.name === 'p');
  assert.ok(nullPointer);
  assert.equal(nullPointer.id, pointsToN.id);
  assert.equal(nullPointer.address, pointsToN.address);
  assert.equal(nullPointer.initialized, true);
  assert.equal(nullPointer.status, 'null');
  assert.equal(nullPointer.displayValue, '0x0');
  const result = runToTerminal(session).result;
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0, 'the write through *p took effect in C');
});

test('inspectPointers exposes exact offsets for array cells, strings and terminators without mutating history', () => {
  const source = `int main(void) {
  int a[3] = { 10, 20, 30 };
  int *p = &a[0];
  p++;
  *p = 99;
  char text[] = "code";
  char *q = text;
  q++;
  char *terminator = text + 4;
  int *one_past = a + 3;
  char *interior_byte = (char *)a + 1;
  int large[11] = { 0 };
  int *large_last = large + 10;
  int matrix[2][2] = { { 1, 2 }, { 3, 4 } };
  int *matrix_cell = &matrix[0][0];
  return a[1] == 99 && *terminator == '\\0' && large_last == large + 10 &&
    matrix_cell == &matrix[0][0] && interior_byte == (char *)a + 1 && one_past == a + 3 ? 0 : 1;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointer-array-cells.c',
    files: [{ name: 'debug-pointer-array-cells.c', source }],
  });
  const session = createDebugSession(prepared);
  const lineOf = (text) => source.split('\n').findIndex((line) => line.trim() === text) + 1;
  assert.equal(pauseBeforeLine(session, lineOf('*p = 99;')).kind, 'paused');

  const locationBeforeInspection = session.currentLocation();
  session.drainEvents();
  const pointerBeforeWrite = session.inspectPointers().find((pointer) => pointer.name === 'p');
  const arraysBeforeWrite = session.inspectArrays();
  const intArrayBeforeWrite = arraysBeforeWrite.arrays.find((array) => array.name === 'a');
  assert.ok(pointerBeforeWrite && intArrayBeforeWrite);
  assert.equal(pointerBeforeWrite.status, 'live');
  assert.equal(pointerBeforeWrite.target?.allocationId, intArrayBeforeWrite.rootId);
  assert.equal(pointerBeforeWrite.target?.type, 'int');
  assert.equal(pointerBeforeWrite.target?.byteOffset, 4, 'p++ preserves the byte-exact offset of a[1]');
  const exactCell = (pointer, array) => array.elements.find((element) =>
    element.type === pointer.target?.type &&
    BigInt(element.address) - BigInt(array.address) === BigInt(pointer.target?.byteOffset ?? -1));
  const pointedCellBeforeWrite = exactCell(pointerBeforeWrite, intArrayBeforeWrite);
  assert.equal(pointedCellBeforeWrite?.index, 1);
  assert.equal(pointerBeforeWrite.displayValue, pointedCellBeforeWrite?.address);
  assert.deepEqual(intArrayBeforeWrite.elements.map((element) => element.displayValue), ['10', '20', '30']);
  assert.equal(Object.isFrozen(pointerBeforeWrite.target), true);
  assert.equal(Object.isFrozen(arraysBeforeWrite), true);
  assert.equal(Object.isFrozen(intArrayBeforeWrite.elements), true);
  assert.equal(Object.isFrozen(intArrayBeforeWrite.elements[1]), true);
  assert.deepEqual(session.currentLocation(), locationBeforeInspection);
  assert.deepEqual(session.drainEvents(), [], 'inspecting the pointer emits no C reads or events');

  const returnLine = source.split('\n').findIndex((line) => line.trim().startsWith('return a[1] == 99')) + 1;
  assert.equal(pauseBeforeLine(session, returnLine).kind, 'paused');
  const locationAtReturn = session.currentLocation();
  const eventsBeforeReturnInspection = session.drainEvents();
  assert.ok(eventsBeforeReturnInspection.some((event) => event.kind === 'object-create' && event.name === 'matrix_cell'));
  const pointers = session.inspectPointers();
  const arraysAfterWrite = session.inspectArrays();
  const intArray = arraysAfterWrite.arrays.find((array) => array.name === 'a');
  const textArray = arraysAfterWrite.arrays.find((array) => array.name === 'text');
  const largeArray = arraysAfterWrite.arrays.find((array) => array.name === 'large');
  const matrix = arraysAfterWrite.arrays.find((array) => array.name === 'matrix');
  assert.ok(intArray && textArray && largeArray && matrix);
  assert.deepEqual(intArray.elements.map((element) => element.displayValue), ['10', '99', '30']);
  assert.deepEqual(intArrayBeforeWrite.elements.map((element) => element.displayValue), ['10', '20', '30'],
    'history preserves the snapshot from before *p = 99');
  assert.deepEqual(pointerBeforeWrite, session.inspectPointers().find((pointer) => pointer.name === 'p'),
    'p’s snapshot remains stable after the indirect write executes');

  const q = pointers.find((pointer) => pointer.name === 'q');
  const terminator = pointers.find((pointer) => pointer.name === 'terminator');
  const onePast = pointers.find((pointer) => pointer.name === 'one_past');
  assert.ok(q && terminator && onePast);
  assert.equal(q.status, 'live');
  assert.equal(q.target?.allocationId, textArray.rootId);
  assert.equal(q.target?.byteOffset, 1, 'q++ advances by one char cell');
  assert.equal(q.target?.type, 'char');
  assert.equal(exactCell(q, textArray)?.index, 1);
  assert.equal(terminator.target?.allocationId, textArray.rootId);
  assert.equal(terminator.target?.byteOffset, 4);
  const nulCell = exactCell(terminator, textArray);
  assert.equal(nulCell?.index, 4);
  assert.equal(nulCell?.displayValue, "'\\0'", 'the final NUL is a real cell in the char array');
  assert.equal(onePast.status, 'one-past');
  assert.equal(onePast.target?.allocationId, intArray.rootId);
  assert.equal(onePast.target?.byteOffset, intArray.size);
  assert.equal(exactCell(onePast, intArray), undefined, 'one-past does not match a visible cell');
  const interiorByte = pointers.find((pointer) => pointer.name === 'interior_byte');
  const largeLast = pointers.find((pointer) => pointer.name === 'large_last');
  const matrixCell = pointers.find((pointer) => pointer.name === 'matrix_cell');
  assert.ok(interiorByte && largeLast && matrixCell);
  assert.equal(interiorByte.target?.allocationId, intArray.rootId);
  assert.equal(interiorByte.target?.byteOffset, 1);
  assert.equal(exactCell(interiorByte, intArray), undefined, 'an interior byte does not match an aligned int cell');
  assert.equal(largeArray.status, 'too-many-elements');
  assert.deepEqual(largeArray.elements, []);
  assert.equal(largeLast.target?.allocationId, largeArray.rootId);
  assert.equal(largeLast.target?.byteOffset, 40);
  assert.equal(exactCell(largeLast, largeArray), undefined, 'an array placeholder publishes no bindable cells');
  assert.equal(matrix.status, 'multidimensional');
  assert.deepEqual(matrix.elements, []);
  assert.equal(matrixCell.target?.allocationId, matrix.rootId);
  assert.equal(matrixCell.target?.byteOffset, 0);
  assert.equal(exactCell(matrixCell, matrix), undefined, 'a matrix is not flattened into a one-dimensional array');
  assert.equal(Object.isFrozen(pointers), true);
  assert.equal(Object.isFrozen(q), true);
  assert.equal(Object.isFrozen(q.target), true);
  assert.deepEqual(structuredClone({ pointers, arraysAfterWrite }), { pointers, arraysAfterWrite });
  assert.deepEqual(session.currentLocation(), locationAtReturn);
  assert.deepEqual(session.drainEvents(), [], 'querying arrays and pointers does not change location or events');

  const result = runToTerminal(session).result;
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0, 'p++ and the write through *p preserve C semantics');
});

test('inspectPointers preserves the identity of parameters, shadowed variables and static locals', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointers-scopes.c',
    files: [{ name: 'debug-pointers-scopes.c', source: `void inspect(int *p) {
  static int *saved;
  int local = 3;
  saved = p;
  {
    int local = 4;
    int *p = &local;
    int value = *p;
  }
}
int main(void) {
  int target = 9;
  inspect(&target);
  return 0;
}
` }],
  });
  const session = createDebugSession(prepared);
  const snapshots = [];
  for (let index = 0; index < 100; index += 1) {
    const progress = session.resume();
    snapshots.push(session.inspectPointers());
    if (progress.kind !== 'paused') {
      assert.equal(progress.kind, 'terminated', JSON.stringify(progress));
      break;
    }
  }
  const shadowed = snapshots.find((snapshot) =>
    snapshot.filter((pointer) => pointer.name === 'p').length === 2 &&
    snapshot.some((pointer) => pointer.name === 'saved' && pointer.duration === 'static'));
  assert.ok(shadowed, 'the activation shows the parameter and shadowed local pointer');
  const pBindings = shadowed.filter((pointer) => pointer.name === 'p');
  assert.equal(pBindings[0].origin, 'parameter');
  assert.equal(pBindings[1].origin, 'variable');
  assert.notEqual(pBindings[0].id, pBindings[1].id);
  assert.equal(pBindings[0].frameId, pBindings[1].frameId);
  assert.notEqual(pBindings[0].scopeId, pBindings[1].scopeId);
  assert.equal(pBindings[0].target?.name, 'target');
  assert.equal(pBindings[1].target?.name, 'local');
  const saved = shadowed.find((pointer) => pointer.name === 'saved');
  assert.ok(saved);
  assert.equal(saved.region, 'static');
  assert.equal(saved.frameId, null);
  assert.equal(saved.scopeId, null);
  assert.equal(saved.status, 'live');
  assert.equal(saved.target?.name, 'target');
});

test('a dangling array target is not associated with cells from another live allocation', () => {
  const source = `int *saved;
void leave(void) {
  int retired[2] = { 1, 2 };
  saved = retired;
}
int main(void) {
  leave();
  int replacement[2] = { 3, 4 };
  int *current = replacement;
  return 0;
}`;
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointer-array-dangling.c',
    files: [{ name: 'debug-pointer-array-dangling.c', source }],
  });
  const session = createDebugSession(prepared);
  const returnLine = source.split('\n').findIndex((line) => line.trim() === 'return 0;') + 1;
  assert.equal(pauseBeforeLine(session, returnLine).kind, 'paused');

  const pointers = session.inspectPointers();
  const arrays = session.inspectArrays().arrays;
  const saved = pointers.find((pointer) => pointer.name === 'saved');
  const current = pointers.find((pointer) => pointer.name === 'current');
  const replacement = arrays.find((array) => array.name === 'replacement');
  assert.ok(saved?.target && current?.target && replacement);
  assert.equal(saved.status, 'dangling');
  assert.equal(current.status, 'live');
  assert.equal(current.target.allocationId, replacement.rootId);
  assert.notEqual(saved.target.allocationId, replacement.rootId,
    'a retired identity is never assigned to the current array');
  assert.equal(arrays.some((array) => array.rootId === saved.target?.allocationId), false,
    'the retired allocation has no live cells in the current snapshot');
  assert.equal(current.target.type, replacement.elementType);
  assert.equal(current.target.byteOffset, 0);
  assert.equal(Object.isFrozen(saved.target), true);
  assert.equal(Object.isFrozen(current.target), true);
});

test('a dangling pointer is not rebound to another object when Stack reuses its address', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointers-reuse.c',
    files: [{ name: 'debug-pointers-reuse.c', source: `int *saved;
void leave(void) {
  {
    int target = 1;
    saved = &target;
  }
}
int main(void) {
  leave();
  {
    int replacement = 2;
    int *current = &replacement;
    int value = *current;
  }
  return 0;
}
` }],
  });
  const session = createDebugSession(prepared);
  const snapshots = [];
  for (let index = 0; index < 100; index += 1) {
    const progress = session.resume();
    snapshots.push(session.inspectPointers());
    if (progress.kind !== 'paused') {
      assert.equal(progress.kind, 'terminated', JSON.stringify(progress));
      break;
    }
  }
  const reused = snapshots.find((snapshot) => {
    const saved = snapshot.find((pointer) => pointer.name === 'saved');
    const current = snapshot.find((pointer) => pointer.name === 'current');
    return saved?.status === 'dangling' && current?.status === 'live';
  });
  assert.ok(reused, 'the dangling value and new object are observed simultaneously');
  const saved = reused.find((pointer) => pointer.name === 'saved');
  const current = reused.find((pointer) => pointer.name === 'current');
  assert.ok(saved?.target && current?.target);
  assert.equal(saved.displayValue, current.displayValue, 'the virtual address was reused');
  assert.notEqual(saved.target.allocationId, current.target.allocationId, 'allocation identity prevents binding to the new object');
  assert.equal(saved.target.name, undefined, 'the name is not inferred from the reused address');
  assert.equal(current.target.name, 'replacement');
});

test('inspectPointers preserves one-past, interior, function and identity-free byte states', () => {
  const prepared = prepareProject(prepare, {
    entry: 'debug-pointers-statuses.c',
    files: [{ name: 'debug-pointers-statuses.c', source: `int add_one(int value) { return value + 1; }
int main(void) {
  int values[2] = { 1, 2 };
  int *interior = values + 1;
  int *one_past = values + 2;
  int (*function)(int) = add_one;
  int *raw = values;
  ((unsigned char *)&raw)[0] = 1;
  return 0;
}
` }],
  });
  const session = createDebugSession(prepared);
  assert.equal(pauseBeforeLine(session, 9).kind, 'paused');
  const pointers = session.inspectPointers();
  const interior = pointers.find((pointer) => pointer.name === 'interior');
  const onePast = pointers.find((pointer) => pointer.name === 'one_past');
  const functionPointer = pointers.find((pointer) => pointer.name === 'function');
  const unmapped = pointers.find((pointer) => pointer.name === 'raw');
  const values = session.inspectArrays().arrays.find((array) => array.name === 'values');
  assert.ok(interior && onePast && functionPointer && unmapped);
  assert.ok(values);
  assert.equal(interior.status, 'live');
  assert.equal(interior.target?.byteOffset, 4);
  assert.equal(interior.target?.name, undefined, 'an interior offset does not inherit the array root name');
  assert.equal(onePast.status, 'one-past');
  assert.equal(onePast.target?.byteOffset, 8);
  assert.equal(onePast.target?.name, undefined);
  assert.equal(functionPointer.status, 'function');
  assert.match(functionPointer.displayValue, /^0x[0-9a-f]+$/);
  assert.equal(functionPointer.target, undefined);
  assert.equal(unmapped.status, 'unmapped');
  assert.equal(unmapped.displayValue, `0x${(BigInt(values.address) + 1n).toString(16)}`);
  assert.equal(unmapped.target, undefined, 'bytes alone do not recover identity from an address');
  const location = session.currentLocation();
  session.drainEvents();
  assert.deepEqual(session.inspectPointers(), pointers);
  assert.deepEqual(session.currentLocation(), location);
  assert.deepEqual(session.drainEvents(), [], 'classifying representations adds no events or diagnostics');
});
