import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, createDebugSession, createExecutionSession, DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS, execute, prepare, VIRTUAL_HEAP_LAYOUT, VIRTUAL_MEMORY_LAYOUT } from '../dist/core/index.js';
import { VirtualMemory } from '../dist/core/memory.js';
import { fixtureProject, prepareProject } from './p4-test-helpers.mjs';

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
  assert.fail(`DebugSession no alcanzó un estado terminal en ${maxSteps} pausas.`);
}

function pauseBeforeLine(session, targetLine, maxSteps = 2_000) {
  for (let index = 0; index < maxSteps; index += 1) {
    const progress = session.resume();
    if (progress.kind !== 'paused' || progress.location.line === targetLine) return progress;
  }
  assert.fail(`DebugSession no alcanzó la línea ${targetLine} en ${maxSteps} pausas.`);
}

function assertLifecycleOnly(events) {
  assert.ok(events.every((event) => lifecycleKinds.has(event.kind)));
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.ok(events.every((event) => !('value' in event) && !('before' in event) && !('after' in event)));
}

test('el inspector de agregados publica campos directos y layout sin alterar la VM', () => {
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
  assert.deepEqual(session.inspectAggregates(), inspection, 'consultar dos veces no cambia el snapshot actual');
  assert.deepEqual(session.currentLocation(), locationBefore, 'la inspección no avanza la ejecución');
  assert.deepEqual(session.drainEvents(), [], 'inspeccionar no crea subobjetos ni eventos');
  assert.deepEqual(structuredClone(inspection), inspection, 'el DTO completo es serializable');
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
  assert.equal(raw.members[1].displayValue, '9', 'la asignación mediante -> llega al mismo campo');
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
    'los campos automáticos no inicializados se publican sin leerlos como C',
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
  assert.equal(previousRaw.members[1].displayValue, '9', 'un snapshot guardado no sigue mutaciones posteriores');
  assert.equal(byName('copy').members[1].displayValue, '9', 'la copia por valor conserva su propia historia');

  const baseline = createDebugSession(prepared);
  assert.equal(pauseBeforeLine(baseline, beforeWriteLine).kind, 'paused');
  assert.equal(pauseBeforeLine(session, laterReturnLine).kind, 'paused');
  assert.equal(pauseBeforeLine(baseline, laterReturnLine).kind, 'paused');
  assert.equal(
    session.inspectAggregates().aggregates.find((aggregate) => aggregate.name === 'later').rootId,
    baseline.inspectAggregates().aggregates.find((aggregate) => aggregate.name === 'later').rootId,
    'inspeccionar no materializa miembros que consuman IDs internos',
  );
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 9, 'la inspección no altera la ejecución C');
});

test('la sesión prepara globals y main, y empieza antes de ejecutar la primera instrucción', () => {
  const prepared = program('debug-main-bootstrap.c');
  const session = createDebugSession(prepared);
  const initialEvents = session.drainEvents();

  const initialLocation = session.currentLocation();
  assert.equal(initialLocation.file, 'debug-main-bootstrap.c');
  assert.equal(initialLocation.line, 5);
  assert.ok(initialLocation.column > 0);
  assert.deepEqual(session.inspectScalars(), [], 'el scope raíz de main no publica declaraciones futuras');
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

test('las automáticas aparecen al ejecutar su declaración y siguen la entrada real a scopes', () => {
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
  assert.equal(entered.length, 1, 'el bloque anidado entra en su acción fuente');
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

test('resume agrupa sentencias de una misma línea y ejecuta el scope de la rama elegida', () => {
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

test('PC repetido en una activación permite avanzar por loops y goto de una sola línea', () => {
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

test('las llamadas recursivas entran por su primera línea y conservan frames dinámicos distintos', () => {
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

test('el cuerpo while compuesto del ejemplo usa un solo scope C por iteración y conserva la etiqueta canónica', () => {
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
  assert.equal(loopEnters.length, 6, 'la lista recorre 1 + 2 + 3 nodos antes de salir del while');
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
      assert.notEqual(index, -1, `scope ${event.scopeId} debe tener un enter previo`);
      activeScopes.splice(index, 1);
    }
  }
  assert.deepEqual(loopStacks.slice(0, 3), [
    ['main', 'appendNode', loopName],
    ['main', 'appendNode', loopName],
    ['main', 'appendNode', loopName],
  ]);
  assert.deepEqual(loopStacks.slice(3), [
    ['main', 'bloque', 'appendNode', loopName],
    ['main', 'bloque', 'appendNode', loopName],
    ['main', 'bloque', 'appendNode', loopName],
  ]);
  assert.deepEqual(activeScopes, [], 'todos los scopes reales salen al terminar main');
  assertLifecycleOnly(run.events);
});

test('if, else, for, do, switch y bloques desnudos conservan scopes y ownership de automáticos', () => {
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
  assert.equal(counts('else'), 0, 'el bloque else no se activa');
  assert.equal(counts('do { ... } while (...)'), 1);
  assert.equal(counts('for(...)'), 1);
  assert.equal(counts('bloque de for'), 2);
  assert.equal(counts('switch(...)'), 2);
  assert.equal(counts('bloque'), 2, 'un bloque del case y el bloque desnudo');
  assert.deepEqual(
    new Set(exits.map((event) => event.scopeId)),
    new Set(enters.map((event) => event.scopeId)),
  );

  const scopeNamesById = new Map(enters.map((event) => [event.scopeId, event.scopeName]));
  for (const name of ['branch', 'loop', 'choice', 'bare']) {
    const created = objects(run.events, 'object-create').find((event) => event.name === name);
    const deleted = objects(run.events, 'object-delete').find((event) => event.allocationId === created?.allocationId);
    assert.ok(created, `${name} debe tener una creación automática`);
    assert.ok(deleted, `${name} debe terminar al cerrar su bloque`);
    assert.equal(deleted.scopeId, created.scopeId);
    assert.equal(scopeNamesById.get(created.scopeId), name === 'branch' ? 'if(...)' : name === 'choice' ? 'bloque' : name === 'bare' ? 'bloque' : 'bloque de for');
  }
  assert.equal(objects(run.events, 'object-create').some((event) => event.name === 'skipped'), false);
  assertLifecycleOnly(run.events);
});

test('continue y break cierran el scope real de cada iteración sin perder el ownership local', () => {
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

test('el fallthrough de una función pausa en su llave de cierre y mantiene ubicaciones de scopes anidados', () => {
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

test('los objetos static y literales de string persisten y se informan una sola vez', () => {
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

test('la inspección static publica escalares y literales reales y conserva los static locales entre llamadas', () => {
  const session = createDebugSession(program('static-memory-inspection.c'));
  const initialEvents = [...session.drainEvents()];
  const initialLocation = session.currentLocation();
  const staticScalarsOnly = session.inspectStaticObjects({ includeStringLiterals: false });
  assert.deepEqual(staticScalarsOnly.map(({ name, origin }) => ({ name, origin })), [
    { name: 'global_zero', origin: 'variable' },
    { name: 'global_value', origin: 'variable' },
  ], 'la opción omite literales antes de construir su preview completo');
  const initialSnapshots = session.inspectStaticObjects();

  assert.deepEqual(initialSnapshots.map(({ name, origin, type, initialized, displayValue }) => ({ name, origin, type, initialized, displayValue })), [
    { name: 'global_zero', origin: 'variable', type: 'int', initialized: true, displayValue: '0' },
    { name: 'global_value', origin: 'variable', type: 'long', initialized: true, displayValue: '41' },
    { name: undefined, origin: 'string-literal', type: 'char[12]', initialized: true, displayValue: '"A\\n\\0001B\\001ABA\\"\\\\\\000"' },
  ]);
  assert.deepEqual(session.currentLocation(), initialLocation, 'la inspección no avanza la VM');
  assert.deepEqual(session.drainEvents(), [], 'la inspección no publica eventos');
  assert.deepEqual(structuredClone(initialSnapshots), initialSnapshots, 'los DTO siguen siendo serializables');
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
  assert.deepEqual(visitsAt(7), ['2', '3'], 'la inicialización explícita ocurre una vez y luego se conserva entre frames');
  assert.deepEqual(visitsAt(8), ['3', '4'], 'las escrituras se inspeccionan sin evento de escritura');
  assert.equal(observations.find((observation) => observation.location?.line === 13)?.snapshots.find((snapshot) => snapshot.name === 'visits')?.displayValue, '3', 'el static local persiste al volver a main');

  const created = objects(events, 'object-create');
  const snapshots = [initialSnapshots, ...observations.map((observation) => observation.snapshots)].flat();
  for (const snapshot of snapshots) {
    const create = created.find((event) => event.allocationId === snapshot.id);
    assert.ok(create, String(snapshot.name ?? snapshot.displayValue) + ' correlaciona con su object-create real');
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
  assert.equal(session.inspectScalars().length, 0, 'la terminación normal cierra escalares automáticos');
  assert.equal(session.inspectStaticObjects().find((snapshot) => snapshot.id === visitsId)?.displayValue, '4', 'los static conservan su valor tras salir de main');
  assertLifecycleOnly(events);
});

test('la inspección de arrays conserva celdas C reales y es no invasiva', () => {
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
  char text[5] = "hola";
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
  assert.deepEqual(session.inspectArrays(), inspection, 'la consulta repetida devuelve el mismo estado actual');
  assert.deepEqual(session.currentLocation(), beforeInspectionLocation, 'la inspección no avanza la ejecución');
  assert.deepEqual(session.drainEvents(), [], 'la inspección no crea objetos ni eventos');
  assert.deepEqual(structuredClone(inspection), inspection, 'el DTO queda serializable');
  assert.equal(inspection.omittedObjects, 0);

  const byName = (name) => inspection.arrays.find((array) => array.name === name);
  const values = byName('values');
  assert.deepEqual(values.elements.map(({ index, initialized, displayValue }) => [index, initialized, displayValue]), [
    [0, true, '10'], [1, true, '20'], [2, true, '0'], [3, true, '0'],
  ], 'la inicialización parcial deja el resto en cero');
  assert.equal(values.status, 'available');
  assert.equal(values.region, 'stack');
  assert.equal(values.elements[0].key, `${values.rootId}:0`);
  assert.equal(values.elements[3].key, `${values.rootId}:3`);
  assert.equal(values.elements[3].address, `0x${(BigInt(values.address) + 12n).toString(16)}`);
  assert.ok(Number.isInteger(values.frameId) && Number.isInteger(values.scopeId));

  const text = byName('text');
  assert.deepEqual(text.elements.map(({ displayValue }) => displayValue), ["'h'", "'o'", "'l'", "'a'", "'\\0'"]);
  assert.equal(text.elements.length, 5, 'el terminador ocupa una celda real');
  const raw = byName('raw');
  assert.deepEqual(raw.elements.map(({ displayValue }) => displayValue), ["'a'", "'b'", "'c'"]);
  assert.equal(raw.elements.length, 3, 'un char array sin NUL es válido y no recibe un terminador inventado');
  assert.deepEqual(byName('untouched').elements.map(({ initialized, displayValue }) => [initialized, displayValue]), [
    [false, '?'], [false, '?'],
  ], 'cada elemento automático no inicializado conserva el estado indeterminado del motor');
  assert.deepEqual(byName('flags').elements.map(({ displayValue }) => displayValue), ['0', '1']);
  assert.equal(byName('floats').elements[0].displayValue, '1.5');
  assert.equal(byName('doubles').elements[0].displayValue, '-0');
  assert.deepEqual(byName('fixed').elements.map(({ displayValue }) => displayValue), ["'Q'", "'\\t'"]);
  assert.equal(byName('fixed').readOnly, true);

  const global = byName('global_big');
  assert.equal(global.region, 'static');
  assert.equal(global.scopeId, null);
  assert.equal(global.frameId, null);
  assert.deepEqual(global.elements.map(({ displayValue }) => displayValue), ['9007199254740993', '-2'], 'LP64 conserva BigInt exacto');
  assert.equal(byName('global_const').readOnly, true);
  const literal = inspection.arrays.find((array) => array.origin === 'string-literal');
  assert.ok(literal);
  assert.equal(literal.type, 'char[3]');
  assert.equal(literal.readOnly, true);
  assert.deepEqual(literal.elements.map(({ displayValue }) => displayValue), ["'A'", "'\\n'", "'\\0'"]);
  assert.ok(session.inspectStaticObjects().some((object) => object.id === literal.rootId && object.origin === 'string-literal'),
    'el canal nuevo conserva identidad con el literal publicado por la API anterior');

  const creates = objects(events, 'object-create');
  for (const array of inspection.arrays) {
    const create = creates.find((event) => event.allocationId === array.rootId);
    assert.ok(create, `el root ${array.rootId} coincide con object-create`);
    assert.equal(array.address, `0x${create.addressVirtual.toString(16)}`);
    assert.equal(array.size, create.size);
  }

  let progress = session.resume();
  assert.equal(progress.kind, 'paused');
  assert.equal(session.inspectArrays().arrays.find((array) => array.name === 'values').elements[0].displayValue, '11', 'postfijo actualiza la celda');
  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  assert.equal(session.inspectArrays().arrays.find((array) => array.name === 'values').elements[1].displayValue, '21', 'prefijo actualiza la celda');
  progress = session.resume();
  assert.equal(progress.kind, 'paused');
  assert.equal(session.inspectArrays().arrays.find((array) => array.name === 'values').elements[2].displayValue, '9', 'la asignación por índice actualiza el elemento');
});

test('arrays grandes, matrices y tipos de elemento no soportados conservan descriptores acotados y no detienen C', () => {
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
  assert.equal(byName('text').length, 11, 'el cap incluye el NUL que completa char texto[]');
  assert.deepEqual(byName('text').elements, []);
  assert.equal(byName('matrix').status, 'multidimensional');
  assert.deepEqual(byName('matrix').elements, []);
  assert.equal(byName('pointers').status, 'unsupported-element-type');
  assert.deepEqual(byName('pointers').elements, []);
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
  assert.equal(cappedInspection.omittedObjects, 5, 'solo los roots excluidos por maxObjects se cuentan como omitidos');
  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 7, 'la limitación visual de arrays no limita la ejecución del motor');
});

test('la inspección sigue raíces vivas de scopes, shadowing y frames distintos', () => {
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
  assert.equal(arrays.length, 3, 'las dos sombras y el array del helper son roots vivos distintos');
  assert.equal(new Set(arrays.map((array) => array.rootId)).size, 3);
  assert.equal(new Set(arrays.map((array) => array.frameId)).size, 2);
  assert.equal(new Set(arrays.map((array) => array.scopeId)).size, 3);
  assert.deepEqual(arrays.map((array) => array.elements[0].displayValue).sort(), ['1', '3', '4'],
    'la raíz exterior conserva 1, la sombra refleja su escritura a 3 y el helper conserva 4');

  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.deepEqual(session.inspectArrays().arrays, [], 'las raíces automáticas desaparecen al salir de sus scopes');
});

test('malloc y free informan el ciclo heap; free(NULL) no añade eventos', () => {
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

test('la inspección heap publica direcciones reales ordenadas, respeta tamaños y desaparece al hacer free', () => {
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
    'el seed permite reproducir direcciones en pruebas',
  );

  const created = objects(first.events, 'object-create').filter((event) => event.origin === 'heap');
  const deleted = objects(first.events, 'object-delete').filter((event) => event.origin === 'heap');
  const creationsById = new Map(created.map((event) => [event.allocationId, event]));
  const initialAddresses = created.slice(0, 3).map((event) => event.addressVirtual);
  assert.ok(initialAddresses[1] < initialAddresses[2] && initialAddresses[2] < initialAddresses[0],
    'el seed de muestra fuerza nuevas allocations antes y en medio del orden por dirección');
  for (const { blocks } of first.observations) {
    assert.deepEqual(blocks.map(({ address }) => BigInt(address)),
      [...blocks].map(({ address }) => BigInt(address)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    'los bloques se ordenan por la dirección virtual exacta');
    for (const block of blocks) {
      const creation = creationsById.get(block.id);
      assert.ok(creation, 'id coincide con un object-create real');
      assert.equal(block.address, `0x${creation.addressVirtual.toString(16)}`);
      assert.equal(block.size, creation.size);
      assert.equal(block.origin, 'heap');
      const address = BigInt(block.address);
      assert.ok(address >= VIRTUAL_HEAP_LAYOUT.start && address < VIRTUAL_HEAP_LAYOUT.endExclusive);
      assert.equal(address % BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes), 0n, 'el inicio cumple alineación LP64 publicada');
    }
    for (let left = 0; left < blocks.length; left += 1) {
      const leftStart = BigInt(blocks[left].address);
      const leftEnd = leftStart + BigInt(blocks[left].size);
      for (let right = left + 1; right < blocks.length; right += 1) {
        const rightStart = BigInt(blocks[right].address);
        const rightEnd = rightStart + BigInt(blocks[right].size);
        assert.ok(leftEnd <= rightStart || rightEnd <= leftStart, 'los rangos vivos no se solapan');
      }
    }
  }
  const afterFreeSecond = first.observations.find(({ line }) => line === 7)?.blocks ?? [];
  assert.equal(afterFreeSecond.length, 2);
  assert.equal(afterFreeSecond.some(({ id }) => id === deleted[0]?.allocationId), false,
    'free elimina el bloque liberado de la inspección');
  assert.equal(created.length, 4);
  assert.equal(deleted.length, 4);
});

test('el layout virtual publica regiones disjuntas Static, Stack y Heap con guard y capacidad compartidos', () => {
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

test('el allocator reutiliza extents liberados y no itera una vez por cada slot reservado', () => {
  const location = { file: 'heap-allocator.test.c', line: 1, column: 1 };
  const memory = new VirtualMemory([], null, { peakMemoryBytes: 0 }, () => 0);
  const heapBytes = VIRTUAL_HEAP_LAYOUT.endExclusive - VIRTUAL_HEAP_LAYOUT.start;
  const largeBlock = Number(heapBytes - BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes * 2));
  const first = memory.allocateRaw(largeBlock, location);
  assert.ok(first);
  const firstAddress = memory.describeObject(memory.rootReference(first.allocationId), location).addressVirtual;
  assert.equal(firstAddress, VIRTUAL_HEAP_LAYOUT.start);
  assert.equal(memory.allocateRaw(1, location), null, 'los slots libres restantes no alcanzan para request y separación');
  assert.equal(memory.allocatedBytes, largeBlock, 'un fallo de espacio no contabiliza bytes vivos');

  memory.free(first, location);
  const replacement = memory.allocateRaw(largeBlock, location);
  assert.ok(replacement);
  const replacementAddress = memory.describeObject(memory.rootReference(replacement.allocationId), location).addressVirtual;
  assert.equal(replacementAddress, firstAddress, 'free libera el intervalo para una asignación posterior');
});

test('malloc devuelve NULL al agotar la región heap virtual y no emite un allocation fantasma', () => {
  const run = runToTerminal(createDebugSession(program('heap-region-exhaustion.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  assert.deepEqual(objects(run.events, 'object-create').filter((event) => event.origin === 'heap'), []);
  assert.deepEqual(objects(run.events, 'object-delete').filter((event) => event.origin === 'heap'), []);
});

test('Static y Stack son regiones independientes, reservan el guard y reutilizan Stack al terminar el scope', () => {
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
    'one-past cae antes del guard y no coincide con la primera base Stack');
  const onePast = memory.pointerAdd(memory.decay(staticBlock), 65520n, location);
  assert.equal(staticAddress + BigInt(onePast.value.byteOffset), firstStackAddress - 16n);
  assert.equal(memory.allocatedBytes, 65521, 'el guard no se suma a los bytes C vivos');

  assert.throws(() => memory.allocate(bytes(1), 'static', location), (error) =>
    error?.diagnostic?.code === 'STATIC_ADDRESS_SPACE_EXHAUSTED' && error.diagnostic.message.includes('guard'));
  assert.equal(memory.allocatedBytes, 65521, 'un fallo de región no publica ni cuenta otra reserva');

  const staleStackPointer = memory.addressOf(stackBlock);
  memory.release(stackBlock, location);
  const replacement = memory.allocate(bytes(1), 'automatic', location);
  assert.equal(memory.describeObject(replacement, location).addressVirtual, firstStackAddress);
  assert.notEqual(replacement.allocationId, stackBlock.allocationId);
  assert.throws(() => memory.assertAlive(staleStackPointer, location), (error) => error?.diagnostic?.code === 'INACTIVE_OBJECT',
    'reutilizar la dirección no revive la procedencia del allocation eliminado');

  const stackExhaustion = new VirtualMemory([], null, { peakMemoryBytes: 0 });
  assert.throws(() => stackExhaustion.allocate(bytes(65521), 'automatic', location), (error) =>
    error?.diagnostic?.code === 'STACK_ADDRESS_SPACE_EXHAUSTED' && error.diagnostic.message.includes('Stack'));
  assert.equal(stackExhaustion.allocatedBytes, 0);

  const budgeted = new VirtualMemory([], 64, { peakMemoryBytes: 0 });
  budgeted.allocate(bytes(32), 'static', location);
  budgeted.allocate(bytes(32), 'automatic', location);
  assert.equal(budgeted.allocatedBytes, 64, 'el presupuesto cuenta bytes C y excluye los guards de ambas regiones');
});

test('scopes sucesivos reutilizan una pila virtual grande y conservan procedencia por allocation', () => {
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
    'el scope posterior reutiliza el extent grande liberado por el anterior');
  assert.notEqual(largeCreates[0].allocationId, largeCreates[1].allocationId);
  assert.ok(large.events.findIndex((event) => event.kind === 'object-delete' && event.allocationId === largeCreates[0].allocationId) <
    large.events.findIndex((event) => event.kind === 'object-create' && event.allocationId === largeCreates[1].allocationId));

  const stale = runToTerminal(createDebugSession(program('stack-reuse-provenance.c')));
  assert.equal(stale.result.kind, 'runtime-error', JSON.stringify(stale.result));
  assert.equal(stale.result.diagnostics[0].code, 'INACTIVE_OBJECT');
  const values = objects(stale.events, 'object-create').filter(({ name }) => name === 'old_value' || name === 'new_value');
  assert.equal(values.length, 2);
  assert.equal(values[0].addressVirtual, values[1].addressVirtual, 'la dirección del scope anterior se reutiliza');
  assert.notEqual(values[0].allocationId, values[1].allocationId);
});

test('reutilizar un address heap no convierte una copia vieja de un puntero en el bloque nuevo', () => {
  const run = runToTerminal(createDebugSession(program('heap-reuse-provenance.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'runtime-error', JSON.stringify(run.result));
  assert.equal(run.result.diagnostics[0].code, 'INACTIVE_OBJECT');
  const created = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  const deleted = objects(run.events, 'object-delete').filter((event) => event.origin === 'heap');
  assert.equal(created.length, 2);
  assert.equal(deleted.length, 1);
  assert.equal(created[0].addressVirtual, deleted[0].addressVirtual);
  assert.equal(created[0].addressVirtual, created[1].addressVirtual, 'seed 0 permite verificar reutilización del primer hueco');
});

test('memcpy conserva un puntero one-past y no lo confunde con la base de otra asignación', () => {
  const run = runToTerminal(createDebugSession(program('heap-onepast-provenance.c'), undefined, { heapAddressSeed: 0 }));
  assert.equal(run.result.kind, 'runtime-error', JSON.stringify(run.result));
  assert.equal(run.result.diagnostics[0].code, 'POINTER_BOUNDS');
  const created = objects(run.events, 'object-create').filter((event) => event.origin === 'heap');
  assert.equal(created.length, 2);
  const firstEnd = created[0].addressVirtual + BigInt(created[0].size);
  assert.ok(created[1].addressVirtual > firstEnd, 'el guard separa one-past de la base heap siguiente');
});

test('free inválido y malloc fallido no generan eventos heap falsos', () => {
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

test('realloc sigue fuera del runtime admitido y se rechaza al preparar', () => {
  const result = prepare(fixtureProject('debug', 'realloc-unavailable.c'));
  assert.equal(result.kind, 'prepare-error');
  assert.equal(result.diagnostics[0].code, 'UNDEFINED_FUNCTION');
});

test('debug ignora stdin y archivos, no pausa ni emite salida, y conserva los stubs puros de buffers', () => {
  const prepared = program('debug-stdio-isolation.c');
  const session = createDebugSession(prepared, {
    io: { stdin: '19\n', files: [{ name: 'absent', data: new Uint8Array([65]) }] },
  });
  const initialEvents = session.drainEvents();
  assert.ok(!objects(initialEvents, 'object-create').some((event) => event.name === 'target'));

  const run = runToTerminal(session);
  assert.equal(run.result.kind, 'terminated', JSON.stringify(run.result));
  assert.equal(run.result.mainReturn, 0);
  assert.deepEqual(run.result.stdout, new Uint8Array());
  assert.deepEqual(run.result.stderr, new Uint8Array());
  assert.ok(!run.steps.some((step) => step.kind === 'input-needed'));

  const created = objects([...initialEvents, ...run.events], 'object-create');
  assert.equal(created.filter((event) => event.name === 'target').length, 1);
  assert.ok(created.some((event) => event.name === 'io_ok'));
  assert.ok(!created.some((event) => event.name === 'io_failed'));
  assertLifecycleOnly([...initialEvents, ...run.events]);
});

test('los límites de eventos conservan un prefijo y no mutan memoria tras agotarse', () => {
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

test('el límite de eventos reserva la publicación de parámetros antes de escribir su argumento', () => {
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
  assert.ok(pendingFrame && pendingScope, 'se conserva el prefijo confirmado de entrada al frame y scope');
  assert.equal(objects(prefix, 'object-create').some((event) => event.name === 'value'), false);
  assert.equal(beforeParameterCreate.inspectScalars().some((scalar) => scalar.name === 'value'), false);

  const afterParameterCreate = createDebugSession(prepared, undefined, { maxEvents: setupEvents.length + 3 });
  const run = runToTerminal(afterParameterCreate);
  assert.equal(run.result.kind, 'debug-limit');
  const parameterCreate = objects(run.events, 'object-create').find((event) => event.name === 'value');
  assert.ok(parameterCreate, 'el presupuesto confirma el object-create del parámetro antes de agotarse');
  assert.equal(parameterCreate.origin, 'parameter');
  assert.deepEqual(afterParameterCreate.inspectScalars().map((scalar) => ({ name: scalar.name, origin: scalar.origin, initialized: scalar.initialized, displayValue: scalar.displayValue })), [
    { name: 'value', origin: 'parameter', initialized: true, displayValue: '42' },
  ]);
});

test('las opciones debug nulas explícitas producen un diagnóstico', () => {
  const session = createDebugSession(program('recursion-frames.c'), undefined, null);
  const result = session.resume();
  assert.equal(result.kind, 'runtime-error');
  assert.equal(result.diagnostics[0].code, 'INVALID_OPTIONS');
  assert.deepEqual(session.drainEvents(), []);
});

test('el límite de instrucciones no fabrica salidas de scope o frame', () => {
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

test('argv sigue configurable, mientras stdin debug desaparece y la sesión normal conserva su contrato', () => {
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
  assert.equal(typeof debug.appendStdin, 'undefined');
  assert.equal(typeof debug.endStdin, 'undefined');
  const debugRun = runToTerminal(debug);
  assert.equal(debugRun.result.kind, 'terminated', JSON.stringify(debugRun.result));
  assert.equal(debugRun.result.mainReturn, 1);
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

test('la instrumentación conserva las métricas y la sesión normal no expone eventos', () => {
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

test('los roots de memoria conservan identidad, duración y ubicación', () => {
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
      assert.ok(range, `duración conocida: ${event.duration}`);
      assert.ok(event.addressVirtual >= range.start);
      assert.ok(event.addressVirtual + BigInt(event.size) + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) <= range.endExclusive,
        'el objeto y su guard quedan dentro de su región');
      assert.equal(event.addressVirtual % BigInt(VIRTUAL_MEMORY_LAYOUT.alignmentBytes), 0n);
      for (const prior of liveAddresses.values()) {
        const priorEnd = prior.address + BigInt(prior.size);
        const eventEnd = event.addressVirtual + BigInt(event.size);
        assert.ok(priorEnd + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) <= event.addressVirtual ||
          eventEnd + BigInt(VIRTUAL_MEMORY_LAYOUT.guardBytes) <= prior.address,
        'los objetos vivos no se solapan y el guard separa one-past de una base vecina');
      }
      liveAddresses.set(event.allocationId, { address: event.addressVirtual, size: event.size });
    } else if (event.kind === 'object-delete') {
      assert.ok(liveAddresses.delete(event.allocationId), 'la eliminación corresponde a un objeto vivo');
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

test('la sesión debug inspecciona escalares automáticos vivos sin leer los no inicializados', () => {
  assert.deepEqual(CAPABILITIES.debugSession.values, {
    liveAutomaticScalars: true,
    liveStaticScalars: true,
    stringLiteralContents: true,
    liveHeapAllocations: true,
    oneDimensionalArithmeticArrays: 'bounded-by-debug-session-options',
    stringLiteralCharacters: 'bounded-by-debug-session-options',
      aggregates: 'bounded-direct-struct-members; unions-opaque',
    pointers: 'basic-identity-aware-binding-snapshots',
      pointerTargetResolution: 'allocation-identity-and-byte-offset-for-bounded-array-cells-and-struct-members',
  });
  assert.equal(CAPABILITIES.debugSession.automaticObjectPublication, 'declaration-execution');
  assert.deepEqual(CAPABILITIES.debugSession.objectOrigins, ['variable', 'parameter', 'compound-literal', 'heap', 'string-literal']);
  const prepared = program('scalar-inspection.c');
  const session = createDebugSession(prepared);
  const initialEvents = [...session.drainEvents()];
  const creates = objects(initialEvents, 'object-create');
  const firstLocation = session.currentLocation();
  const before = session.inspectScalars();
  assert.deepEqual(before, [], 'main ya tiene scope activo, pero ninguna declaración local ejecutada');
  assert.equal(creates.some((event) => event.duration === 'automatic'), false);
  assert.deepEqual(session.currentLocation(), firstLocation, 'la inspección no avanza la VM');
  assert.deepEqual(session.drainEvents(), [], 'la inspección no genera eventos');
  assert.deepEqual(structuredClone(before), before, 'los DTO son serializables');

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
    assert.ok(created, `${scalar.name} comparte ID con su object-create real`);
    assert.equal(created.scopeId, scalar.scopeId);
    assert.equal(created.frameId, scalar.frameId);
    assert.equal(created.origin, scalar.origin);
    assert.equal(scalar.address, `0x${created.addressVirtual.toString(16)}`);
    assert.equal(scalar.size, created.size);
  }
  assert.deepEqual(objects(observations[0].emitted, 'object-create').map((event) => event.name), ['largo']);
  assert.deepEqual(observations[0].scalars.map((scalar) => [scalar.name, scalar.initialized, scalar.displayValue]), [
    ['largo', true, '9007199254740993'],
  ]);
  const hasValue = (name, type, value) => all.some((scalar) => scalar.name === name && scalar.type === type && scalar.displayValue === value);
  assert.ok(hasValue('largo', 'long', '9007199254740993'));
  assert.ok(hasValue('muy_largo', 'long long', '-9223372036854775808'));
  assert.ok(hasValue('sin_signo', 'unsigned long long', '18446744073709551615'));
  assert.ok(hasValue('activo', '_Bool', '1'));
  assert.ok(hasValue('letra', 'char', "'C'"));
  assert.ok(hasValue('nueva_linea', 'char', "'\\n'"));
  assert.ok(hasValue('corto', 'short', '-1234'));
  assert.ok(hasValue('decimal', 'float', '3.5'));
  assert.ok(hasValue('precision', 'double', '2.718281828459045'));
  assert.ok(hasValue('cero_negativo', 'double', '-0'));
  assert.ok(hasValue('estado', 'int', '4'), 'enum conserva la representación int del perfil');
  assert.ok(all.filter((scalar) => scalar.name === 'pendiente').every((scalar) => !scalar.initialized && scalar.displayValue === '?'));
  assert.ok(all.some((scalar) => scalar.name === 'mutable' && scalar.displayValue === '1'));
  assert.ok(all.some((scalar) => scalar.name === 'mutable' && scalar.displayValue === '2'), 'la asignación posterior se refleja sin evento de escritura');

  const temporal = all.find((scalar) => scalar.name === 'temporal');
  assert.ok(temporal);
  const laterSnapshots = observations.slice(observations.findIndex((item) => item.scalars.some((scalar) => scalar.id === temporal.id)) + 1);
  assert.ok(laterSnapshots.some((item) => !item.scalars.some((scalar) => scalar.id === temporal.id)), 'el valor desaparece al cerrar el scope');
  assert.ok(all.some((scalar) => scalar.name === 'parametro' && scalar.displayValue === '2'));
  assert.ok(all.some((scalar) => scalar.name === 'parametro' && scalar.origin === 'parameter'));
  assert.ok(all.some((scalar) => scalar.name === 'local' && scalar.displayValue === '2'));
  assert.ok(all.some((scalar) => scalar.name === 'local' && scalar.origin === 'variable'));
  assert.ok(all.some((scalar) => scalar.name === 'local' && scalar.displayValue === '3'));
  const adjustFrame = objects(events, 'frame-enter').find((event) => event.functionName === 'ajustar');
  const adjustScope = objects(events, 'scope-enter').find((event) => event.frameId === adjustFrame.frameId);
  const parameterCreate = allCreates.find((event) => event.name === 'parametro');
  const firstLocalCreate = allCreates.find((event) => event.name === 'local');
  assert.ok(adjustFrame.sequence < adjustScope.sequence && adjustScope.sequence < parameterCreate.sequence);
  assert.ok(parameterCreate.sequence < firstLocalCreate.sequence, 'el parámetro se publica al entrar, antes de la primera declaración local');
  assert.equal(parameterCreate.origin, 'parameter');
  assert.equal(firstLocalCreate.origin, 'variable');
  assert.equal(parameterCreate.frameId, adjustFrame.frameId);
  assert.deepEqual(session.inspectScalars(), [], 'el retorno normal cierra los scopes y sus objetos');
  assert.equal(session.currentLocation(), null);
});

test('los parámetros recursivos conservan origen, frame y scope hasta el retorno de cada activación', () => {
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
  assert.ok(deepest, 'se observan a la vez las cuatro activaciones recursivas');
  const parameters = deepest.filter((scalar) => scalar.name === 'remaining');
  const locals = deepest.filter((scalar) => scalar.name === 'saved');
  assert.equal(new Set(parameters.map((scalar) => scalar.frameId)).size, 4);
  assert.equal(new Set(parameters.map((scalar) => scalar.scopeId)).size, 4);
  assert.equal(new Set(parameters.map((scalar) => scalar.id)).size, 4);
  assert.deepEqual(parameters.map((scalar) => scalar.origin), ['parameter', 'parameter', 'parameter', 'parameter']);
  assert.deepEqual(locals.map((scalar) => scalar.origin), ['variable', 'variable', 'variable', 'variable']);
  for (const parameter of parameters) {
    const local = locals.find((scalar) => scalar.frameId === parameter.frameId);
    assert.ok(local, `la variable local comparte la activación ${parameter.frameId}`);
    assert.equal(local.scopeId, parameter.scopeId, 'parámetro y local comparten el scope raíz de la función');
    assert.notEqual(local.id, parameter.id);
    assert.notEqual(local.address, parameter.address);
  }
  assert.equal(new Set(deepest.map((scalar) => scalar.id)).size, deepest.length, 'las celdas vivas no aliasan sus asignaciones');
  assert.equal(new Set(deepest.map((scalar) => scalar.address)).size, deepest.length, 'las celdas vivas tienen direcciones distintas');

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
    assert.ok(deleted, `el retorno elimina ${created.name} de su activación`);
    assert.equal(deleted.frameId, created.frameId);
    assert.equal(deleted.scopeId, created.scopeId);
    assert.equal(deleted.origin, created.origin);
  }
  assert.deepEqual(session.inspectScalars(), [], 'todas las activaciones y parámetros desaparecen al retornar');
});

test('la inspección conserva objetos vivos al detenerse por error y no inventa unwinds', () => {
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
  assert.deepEqual(objects(events, 'object-delete'), [], 'el error no elimina objetos vivos');
  assert.equal(objects(events, 'scope-exit').length, 0, 'el error no sintetiza cierres');
});

test('inspectPointers separa la dirección propia del valor, observa NULL y no ejecuta lecturas C', () => {
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
  assert.deepEqual(session.drainEvents(), [], 'inspeccionar no genera eventos');
  assert.equal(Object.isFrozen(repeated), true);
  assert.equal(Object.isFrozen(uninitialized), true);
  assert.deepEqual(structuredClone(repeated), repeated, 'los snapshots se serializan sin convertir direcciones a Number');

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
  assert.deepEqual(afterIndirectWrite, pointsToN, 'escribir *p no altera la identidad ni produce un valor target');
  assert.equal(session.inspectScalars().find((scalar) => scalar.name === 'n')?.displayValue, '9');

  assert.equal(pauseBeforeLine(session, 9).kind, 'paused');
  const pointsToOther = session.inspectPointers().find((pointer) => pointer.name === 'p');
  const other = session.inspectScalars().find((scalar) => scalar.name === 'other');
  assert.ok(pointsToOther && other);
  assert.equal(pointsToOther.id, pointsToN.id);
  assert.equal(pointsToOther.address, pointsToN.address, 'la dirección de p no depende de su valor');
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
  assert.equal(result.mainReturn, 0, 'la escritura mediante *p tuvo efecto en C');
});

test('inspectPointers expone offsets exactos para celdas de arrays, cadenas y terminadores sin mutar historial', () => {
  const source = `int main(void) {
  int a[3] = { 10, 20, 30 };
  int *p = &a[0];
  p++;
  *p = 99;
  char texto[] = "hola";
  char *q = texto;
  q++;
  char *terminator = texto + 4;
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
  assert.equal(pointerBeforeWrite.target?.byteOffset, 4, 'p++ conserva el offset byte-exacto de a[1]');
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
  assert.deepEqual(session.drainEvents(), [], 'inspeccionar el puntero no emite lecturas C ni eventos');

  const returnLine = source.split('\n').findIndex((line) => line.trim().startsWith('return a[1] == 99')) + 1;
  assert.equal(pauseBeforeLine(session, returnLine).kind, 'paused');
  const locationAtReturn = session.currentLocation();
  const eventsBeforeReturnInspection = session.drainEvents();
  assert.ok(eventsBeforeReturnInspection.some((event) => event.kind === 'object-create' && event.name === 'matrix_cell'));
  const pointers = session.inspectPointers();
  const arraysAfterWrite = session.inspectArrays();
  const intArray = arraysAfterWrite.arrays.find((array) => array.name === 'a');
  const textArray = arraysAfterWrite.arrays.find((array) => array.name === 'texto');
  const largeArray = arraysAfterWrite.arrays.find((array) => array.name === 'large');
  const matrix = arraysAfterWrite.arrays.find((array) => array.name === 'matrix');
  assert.ok(intArray && textArray && largeArray && matrix);
  assert.deepEqual(intArray.elements.map((element) => element.displayValue), ['10', '99', '30']);
  assert.deepEqual(intArrayBeforeWrite.elements.map((element) => element.displayValue), ['10', '20', '30'],
    'el historial conserva el snapshot previo a *p = 99');
  assert.deepEqual(pointerBeforeWrite, session.inspectPointers().find((pointer) => pointer.name === 'p'),
    'el snapshot de p permanece estable después de ejecutar la escritura indirecta');

  const q = pointers.find((pointer) => pointer.name === 'q');
  const terminator = pointers.find((pointer) => pointer.name === 'terminator');
  const onePast = pointers.find((pointer) => pointer.name === 'one_past');
  assert.ok(q && terminator && onePast);
  assert.equal(q.status, 'live');
  assert.equal(q.target?.allocationId, textArray.rootId);
  assert.equal(q.target?.byteOffset, 1, 'q++ avanza una celda char');
  assert.equal(q.target?.type, 'char');
  assert.equal(exactCell(q, textArray)?.index, 1);
  assert.equal(terminator.target?.allocationId, textArray.rootId);
  assert.equal(terminator.target?.byteOffset, 4);
  const nulCell = exactCell(terminator, textArray);
  assert.equal(nulCell?.index, 4);
  assert.equal(nulCell?.displayValue, "'\\0'", 'el NUL final es una celda real del array de char');
  assert.equal(onePast.status, 'one-past');
  assert.equal(onePast.target?.allocationId, intArray.rootId);
  assert.equal(onePast.target?.byteOffset, intArray.size);
  assert.equal(exactCell(onePast, intArray), undefined, 'one-past no coincide con una celda visible');
  const interiorByte = pointers.find((pointer) => pointer.name === 'interior_byte');
  const largeLast = pointers.find((pointer) => pointer.name === 'large_last');
  const matrixCell = pointers.find((pointer) => pointer.name === 'matrix_cell');
  assert.ok(interiorByte && largeLast && matrixCell);
  assert.equal(interiorByte.target?.allocationId, intArray.rootId);
  assert.equal(interiorByte.target?.byteOffset, 1);
  assert.equal(exactCell(interiorByte, intArray), undefined, 'un byte interior no coincide con una celda int alineada');
  assert.equal(largeArray.status, 'too-many-elements');
  assert.deepEqual(largeArray.elements, []);
  assert.equal(largeLast.target?.allocationId, largeArray.rootId);
  assert.equal(largeLast.target?.byteOffset, 40);
  assert.equal(exactCell(largeLast, largeArray), undefined, 'un array placeholder no publica celdas enlazables');
  assert.equal(matrix.status, 'multidimensional');
  assert.deepEqual(matrix.elements, []);
  assert.equal(matrixCell.target?.allocationId, matrix.rootId);
  assert.equal(matrixCell.target?.byteOffset, 0);
  assert.equal(exactCell(matrixCell, matrix), undefined, 'una matriz no se aplana como array unidimensional');
  assert.equal(Object.isFrozen(pointers), true);
  assert.equal(Object.isFrozen(q), true);
  assert.equal(Object.isFrozen(q.target), true);
  assert.deepEqual(structuredClone({ pointers, arraysAfterWrite }), { pointers, arraysAfterWrite });
  assert.deepEqual(session.currentLocation(), locationAtReturn);
  assert.deepEqual(session.drainEvents(), [], 'consultar arrays y punteros no cambia ubicación ni eventos');

  const result = runToTerminal(session).result;
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0, 'p++ y la escritura por *p conservan la semántica C');
});

test('inspectPointers conserva identidad de parámetros, sombras y static locals', () => {
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
  assert.ok(shadowed, 'la activación muestra el parámetro y el puntero local sombreado');
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

test('un target dangling de array no se asocia con las celdas de otro allocation vivo', () => {
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
    'la identidad retirada nunca se asigna al array actual');
  assert.equal(arrays.some((array) => array.rootId === saved.target?.allocationId), false,
    'el allocation retired no tiene celdas vivas en el snapshot actual');
  assert.equal(current.target.type, replacement.elementType);
  assert.equal(current.target.byteOffset, 0);
  assert.equal(Object.isFrozen(saved.target), true);
  assert.equal(Object.isFrozen(current.target), true);
});

test('un pointer dangling no se religa a otro objeto cuando Stack reutiliza su dirección', () => {
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
  assert.ok(reused, 'se observan simultáneamente el valor dangling y el objeto nuevo');
  const saved = reused.find((pointer) => pointer.name === 'saved');
  const current = reused.find((pointer) => pointer.name === 'current');
  assert.ok(saved?.target && current?.target);
  assert.equal(saved.displayValue, current.displayValue, 'la dirección virtual fue reutilizada');
  assert.notEqual(saved.target.allocationId, current.target.allocationId, 'la identidad de allocation evita enlazar el objeto nuevo');
  assert.equal(saved.target.name, undefined, 'no se infiere el nombre por la dirección reutilizada');
  assert.equal(current.target.name, 'replacement');
});

test('inspectPointers conserva estados one-past, interiores, function y bytes sin identidad', () => {
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
  assert.equal(interior.target?.name, undefined, 'un offset interior no hereda el nombre del array root');
  assert.equal(onePast.status, 'one-past');
  assert.equal(onePast.target?.byteOffset, 8);
  assert.equal(onePast.target?.name, undefined);
  assert.equal(functionPointer.status, 'function');
  assert.match(functionPointer.displayValue, /^0x[0-9a-f]+$/);
  assert.equal(functionPointer.target, undefined);
  assert.equal(unmapped.status, 'unmapped');
  assert.equal(unmapped.displayValue, `0x${(BigInt(values.address) + 1n).toString(16)}`);
  assert.equal(unmapped.target, undefined, 'los bytes por sí solos no recuperan identidad por dirección');
  const location = session.currentLocation();
  session.drainEvents();
  assert.deepEqual(session.inspectPointers(), pointers);
  assert.deepEqual(session.currentLocation(), location);
  assert.deepEqual(session.drainEvents(), [], 'clasificar representaciones no añade eventos ni diagnósticos');
});
