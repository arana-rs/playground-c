import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createDebugSession, prepare, VIRTUAL_HEAP_LAYOUT } from '@playground/c11-engine/core';
import { runFile } from '@playground/c11-engine/browser';
import { RUN_CONFIGURATION } from '../src/execution/useRunner.ts';

const initialExampleSource = readFileSync(new URL('../src/examples/main.c', import.meta.url), 'utf8');
const heapLifecycleSource = [
  '#include <stdlib.h>',
  'int main(void) {',
  '    int *small = malloc(2 * sizeof(int));',
  '    int *medium = malloc(5 * sizeof(int));',
  '    int *large = malloc(9 * sizeof(int));',
  '    free(medium);',
  '    medium = NULL;',
  '    medium = malloc(3 * sizeof(int));',
  '    free(small);',
  '    free(large);',
  '    free(medium);',
  '    return 0;',
  '}',
].join('\n');

test('the initial memory example runs to return zero without I/O', async () => {
  const file = new File([initialExampleSource], 'main.c', { type: 'text/x-c' });
  const result = await runFile(file, RUN_CONFIGURATION.options);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdout, new Uint8Array());
  assert.deepEqual(result.stderr, new Uint8Array());
});

test('debug tracks heap allocations through free and replacement with a focused fixture', () => {
  const prepared = prepare({
    entry: 'main.c',
    files: [{ name: 'main.c', source: heapLifecycleSource }],
  });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));

  const session = createDebugSession(prepared.program);
  const events = [...session.drainEvents()];
  const heapSnapshots = [session.inspectHeapObjects()];
  let result;
  for (let index = 0; index < 1_000; index += 1) {
    const progress = session.resume();
    const stepEvents = session.drainEvents();
    events.push(...stepEvents);
    heapSnapshots.push(session.inspectHeapObjects());
    if (progress.kind !== 'paused') {
      result = progress;
      break;
    }
    assert.deepEqual(session.currentLocation(), progress.location);
  }
  assert.ok(result, 'La sesión debug no alcanzó un estado terminal en 1.000 pausas.');
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
  assert.deepEqual(result.stdout, new Uint8Array());
  assert.deepEqual(result.stderr, new Uint8Array());
  const heapCreates = events.filter(event => event.kind === 'object-create' && event.duration === 'heap');
  const heapDeletes = events.filter(event => event.kind === 'object-delete' && event.duration === 'heap');
  assert.equal(heapCreates.length, 4, 'las tres reservas iniciales y la reserva tras el free producen objetos heap reales');
  assert.equal(heapDeletes.length, heapCreates.length, 'el ejemplo libera todos sus bloques heap antes de terminar');
  assert.deepEqual(heapCreates.map(event => event.size), [8, 20, 36, 12]);
  assert.ok(heapCreates.every(event => event.origin === 'heap' && event.frameId === null && event.scopeId === null));

  const liveHeap = new Map();
  for (const event of events.filter(event => event.duration === 'heap')) {
    if (event.kind === 'object-create') {
      assert.equal(event.addressVirtual % BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes), 0n, 'el base heap conserva la alineación de malloc');
      const start = event.addressVirtual;
      const end = start + BigInt(event.size);
      assert.ok(start >= VIRTUAL_HEAP_LAYOUT.start);
      assert.ok(end <= VIRTUAL_HEAP_LAYOUT.endExclusive);
      for (const other of liveHeap.values()) {
        const otherStart = other.addressVirtual;
        const otherEnd = otherStart + BigInt(other.size);
        assert.ok(end <= otherStart || otherEnd <= start, 'dos bloques heap vivos no comparten bytes');
      }
      liveHeap.set(event.allocationId, event);
      continue;
    }

    const created = liveHeap.get(event.allocationId);
    assert.ok(created, 'free elimina una asignación heap que seguía viva');
    assert.equal(event.objectId, created.objectId);
    assert.equal(event.addressVirtual, created.addressVirtual);
    assert.equal(event.size, created.size);
    assert.ok(created.sequence < event.sequence);
    liveHeap.delete(event.allocationId);
  }
  assert.equal(liveHeap.size, 0, 'el heap queda vacío tras el último free');

  const createsById = new Map(heapCreates.map(event => [event.allocationId, event]));
  for (const snapshot of heapSnapshots) {
    const addresses = snapshot.map(object => BigInt(object.address));
    assert.deepEqual(addresses, [...addresses].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    assert.equal(new Set(snapshot.map(object => object.id)).size, snapshot.length);
    for (const object of snapshot) {
      const address = BigInt(object.address);
      assert.ok(Number.isSafeInteger(object.id) && object.id > 0);
      assert.equal(object.origin, 'heap');
      assert.ok(address >= VIRTUAL_HEAP_LAYOUT.start);
      assert.ok(address + BigInt(object.size) <= VIRTUAL_HEAP_LAYOUT.endExclusive);
      assert.equal(address % BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes), 0n);
      const created = createsById.get(object.id);
      assert.ok(created, `el snapshot ${object.id} proviene de un object-create real`);
      assert.equal(object.address, `0x${created.addressVirtual.toString(16)}`);
      assert.equal(object.size, created.size);
    }
  }

  const initialCreates = heapCreates.slice(0, 3);
  const initialIds = initialCreates.map(event => event.allocationId);
  const beforeReleaseIndex = heapSnapshots.findIndex(snapshot =>
    initialIds.every(id => snapshot.some(object => object.id === id)));
  assert.ok(beforeReleaseIndex >= 0, 'los tres bloques distintos aparecen juntos antes del primer free');
  const beforeRelease = heapSnapshots[beforeReleaseIndex];
  const medium = initialCreates.find(event => event.size === 20);
  assert.ok(medium);
  const mediumRelease = heapDeletes.find(event => event.allocationId === medium.allocationId);
  assert.ok(mediumRelease);
  const afterReleaseIndex = heapSnapshots.findIndex((snapshot, index) =>
    index > beforeReleaseIndex
      && !snapshot.some(object => object.id === medium.allocationId)
      && initialIds.filter(id => id !== medium.allocationId).every(id => snapshot.some(object => object.id === id)));
  assert.ok(afterReleaseIndex > beforeReleaseIndex, 'free quita del snapshot el bloque mediano por su identidad real');
  assert.ok(beforeRelease.some(object => object.id === medium.allocationId), 'el snapshot histórico previo conserva el objeto liberado');
  const replacement = heapCreates[3];
  assert.ok(replacement);
  const afterReplacement = heapSnapshots.slice(afterReleaseIndex + 1)
    .find(snapshot => snapshot.some(object => object.id === replacement.allocationId));
  assert.ok(afterReplacement, 'la reserva posterior vuelve a aparecer con una identidad propia');
  assert.ok(!afterReplacement.some(object => object.id === medium.allocationId));
  assert.deepEqual(
    new Set(afterReplacement.map(object => object.id)),
    new Set([...initialIds.filter(id => id !== medium.allocationId), replacement.allocationId]),
  );
  assert.equal(heapSnapshots.at(-1).length, 0, 'el último snapshot confirma la desaparición de todos los bloques');
});

test('the full P2-P4 example remains covered with the editor execution budgets', async () => {
  const source = readFileSync(new URL('../src/examples/p2-p4-full-demo.c', import.meta.url), 'utf8');
  const file = new File([source], 'main.c', { type: 'text/x-c' });
  for (let run = 0; run < 2; run++) {
    const result = await runFile(file, RUN_CONFIGURATION.options);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 42, `Example group ${result.mainReturn} failed.`);
    assert.equal(result.exitCode, 42);
    assert.equal(new TextDecoder().decode(result.stdout), [
      'P4 macros, conditional, #undef y argv: ok',
      'P4 static inline, K&R y va_copy: ok',
      'P4 output value:42',
      'P4 printf/snprintf y archivo binario virtual: ok',
      'P4 string, ctype, errno, inttypes y assert: ok',
      '',
    ].join('\n'));
    assert.deepEqual(result.stderr, new Uint8Array());
  }
});
