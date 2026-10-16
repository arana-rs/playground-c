import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';
import { findMemoryViewerChangedAggregateMemberKeys } from '../src/memory/aggregateSnapshots.ts';

const aggregateSource = readFileSync(new URL('./fixtures/memory-viewer-structs.c', import.meta.url), 'utf8');

class InlineMemoryWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  terminated = false;

  constructor(scope) {
    this.scope = scope;
  }

  postMessage(data) {
    this.scope.onmessage?.({ data });
  }

  terminate() {
    this.terminated = true;
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

async function waitOneTurn() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function createAggregateController() {
  const responses = [];
  let worker = null;
  const scope = {
    onmessage: null,
    postMessage(response) {
      responses.push(response);
      worker?.emit(response);
    },
  };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-aggregate-controller-integration');
    const controller = new MemoryViewerController(aggregateSource, {
      workerFactory: () => {
        worker = new InlineMemoryWorker(scope);
        return worker;
      },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
    });
    controller.start();
    await waitOneTurn();
    return { controller, responses, restoreSelf: () => {
      if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
      else delete globalThis.self;
    } };
  } catch (error) {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
    throw error;
  }
}

function aggregateNamed(state, name) {
  return state.aggregates.find(aggregate => aggregate.name === name);
}

function memberNamed(aggregate, name) {
  return aggregate?.members.find(member => member.name === name);
}

function pointerNamed(state, name) {
  return state.pointers.find(pointer => pointer.name === name);
}

test('el Worker y el historial del Memory Viewer conservan layout, placeholders y enlaces de structs', async () => {
  const { controller, responses, restoreSelf } = await createAggregateController();

  try {
    assert.equal(responses[0]?.type, 'debug-ready');
    assert.ok(responses.every(response => Array.isArray(response.aggregates)));
    assert.ok(responses.every(response => Number.isInteger(response.omittedAggregateObjects)));

    const states = [controller.state];
    for (let request = 0; request < 40 && !['terminated', 'error', 'limit'].includes(controller.state.status); request += 1) {
      controller.next();
      await waitOneTurn();
      states.push(controller.state);
    }

    assert.equal(controller.state.status, 'terminated');
    assert.equal(controller.state.omittedAggregateObjects, 0);
    assert.ok(states.some(state => aggregateNamed(state, 's')));

    const uninitializedState = states.find(state => {
      const aggregate = aggregateNamed(state, 's');
      return aggregate && memberNamed(aggregate, 'first')?.initialized === false;
    });
    assert.ok(uninitializedState, 'el objeto local existe antes de asignar sus campos');

    const initial = aggregateNamed(uninitializedState, 's');
    assert.equal(initial.status, 'available');
    assert.equal(initial.kind, 'struct');
    assert.equal(initial.memberCount, 8);
    assert.equal(initial.size, 48);
    assert.equal(initial.readOnly, false);
    assert.deepEqual(initial.members.map(({ name }) => name), [
      'first', 'tag', 'link', 'value', 'values', 'nested', 'choice', 'tail',
    ]);
    assert.deepEqual(initial.members.map(({ name, offset, size }) => [name, offset, size]), [
      ['first', 0, 4],
      ['tag', 4, 1],
      ['link', 8, 8],
      ['value', 16, 4],
      ['values', 20, 8],
      ['nested', 28, 8],
      ['choice', 36, 4],
      ['tail', 40, 1],
    ]);
    assert.deepEqual(initial.padding.map(({ offset, size }) => [offset, size]), [[5, 3], [41, 7]]);

    for (const name of ['first', 'tag', 'link', 'value', 'tail']) {
      const member = memberNamed(initial, name);
      assert.equal(member.initialized, false, `${name} empieza sin inicializar`);
      assert.equal(member.displayValue, '?');
    }
    for (const [name, reason, offset, size] of [
      ['values', 'array', 20, 8],
      ['nested', 'aggregate', 28, 8],
      ['choice', 'aggregate', 36, 4],
    ]) {
      const placeholder = memberNamed(initial, name);
      assert.equal(placeholder.kind, 'unsupported');
      assert.equal(placeholder.unsupportedReason, reason);
      assert.equal(placeholder.initialized, null);
      assert.equal(placeholder.displayValue, null);
      assert.deepEqual([placeholder.offset, placeholder.size], [offset, size]);
    }

    const rootUnion = states.map(state => aggregateNamed(state, 'whole_union')).find(Boolean);
    const tooMany = states.map(state => aggregateNamed(state, 'too_many')).find(Boolean);
    assert.equal(rootUnion?.kind, 'union');
    assert.equal(rootUnion?.memberCount, 2);
    assert.equal(rootUnion?.status, 'unsupported-union');
    assert.deepEqual(rootUnion?.members, []);
    assert.deepEqual(rootUnion?.padding, []);
    assert.equal(tooMany?.kind, 'struct');
    assert.equal(tooMany?.memberCount, 11);
    assert.equal(tooMany?.status, 'too-many-members');
    assert.deepEqual(tooMany?.members, []);
    assert.deepEqual(tooMany?.padding, []);

    const firstAssigned = states.find(state => memberNamed(aggregateNamed(state, 's'), 'first')?.displayValue === '5');
    const valueSeven = states.find(state => memberNamed(aggregateNamed(state, 's'), 'value')?.displayValue === '7');
    const valueNine = states.find(state => memberNamed(aggregateNamed(state, 's'), 'value')?.displayValue === '9');
    assert.ok(firstAssigned && valueSeven && valueNine, 'los accesos . y -> modifican los campos observables');
    const rootId = aggregateNamed(firstAssigned, 's').rootId;
    assert.equal(memberNamed(aggregateNamed(firstAssigned, 's'), 'first').initialized, true);
    assert.deepEqual(
      findMemoryViewerChangedAggregateMemberKeys(uninitializedState.aggregates, firstAssigned.aggregates),
      [`${rootId}:0`],
      'la delta identifica el campo inicializado sin marcar a sus vecinos',
    );
    assert.deepEqual(
      findMemoryViewerChangedAggregateMemberKeys(valueSeven.aggregates, valueNine.aggregates),
      [`${rootId}:3`],
      'la asignación mediante -> cambia únicamente value',
    );

    const targetState = states.find(state => {
      const link = memberNamed(aggregateNamed(state, 's'), 'link');
      const target = state.stackScalars.find(scalar => scalar.name === 'target');
      return target !== undefined && link?.target?.allocationId === target.id;
    });
    const fieldPointerState = states.find(state => {
      const link = memberNamed(aggregateNamed(state, 's'), 'link');
      return link?.target?.allocationId === rootId && link.target.byteOffset === 0 && link.target.type === 'int';
    });
    assert.ok(targetState, 'el miembro puntero link resuelve un escalar vecino');
    assert.ok(fieldPointerState, 'el miembro puntero puede apuntar al primer campo del struct');
    assert.equal(memberNamed(aggregateNamed(targetState, 's'), 'link').pointerStatus, 'live');
    assert.deepEqual(
      findMemoryViewerChangedAggregateMemberKeys(valueNine.aggregates, fieldPointerState.aggregates),
      [`${rootId}:2`],
      'la delta incluye el miembro puntero cuando cambia su destino',
    );

    const firstPointer = pointerNamed(fieldPointerState, 'first');
    const rootPointer = pointerNamed(fieldPointerState, 'root');
    assert.equal(firstPointer?.target?.allocationId, rootId);
    assert.equal(firstPointer?.target?.byteOffset, 0);
    assert.equal(firstPointer?.target?.type, 'int');
    assert.equal(rootPointer?.target?.allocationId, rootId);
    assert.equal(rootPointer?.target?.byteOffset, 0);
    assert.equal(rootPointer?.target?.type, 'struct S');
    assert.notEqual(firstPointer?.target?.type, rootPointer?.target?.type,
      'un int * a s.first y un struct S * a s comparten offset, pero no destino de tipo');

    while (controller.state.stepIndex > valueSeven.stepIndex) controller.previous();
    assert.equal(memberNamed(aggregateNamed(controller.state, 's'), 'value').displayValue, '7');
    controller.next();
    assert.equal(memberNamed(aggregateNamed(controller.state, 's'), 'value').displayValue, '9',
      'Next restaura el snapshot posterior a root->value');
  } finally {
    controller.dispose();
    restoreSelf();
  }
});
