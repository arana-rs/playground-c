import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeSyntax, createDebugSession, prepare, VIRTUAL_HEAP_LAYOUT } from '@playground/c11-engine/core';
import { runFile } from '@playground/c11-engine/browser';
import { RUN_CONFIGURATION } from '../src/execution/useRunner.ts';

const initialExampleSource = readFileSync(new URL('../src/examples/main.c', import.meta.url), 'utf8');
const terminalDemoSource = [
  '#include <stdio.h>',
  'int main(void) {',
  '    printf("This message will be cleared by CSI 2J, then the cursor will return home.\\n");',
  '    printf("\\x1b[2J\\x1b[H");',
  '    printf("Carriage return replaces an equal-length line:\\n");',
  '    printf("OLD TEXT\\rNEW TEXT\\n");',
  '    printf("Backspace moves left, then C replaces X:\\n");',
  '    printf("ABX\\bC\\n");',
  '    printf("Carriage return + CSI 2K clears the current line:\\n");',
  '    printf("Discarded text that will disappear");',
  '    printf("\\r\\x1b[2K");',
  '    printf("Clean replacement after CSI 2K.\\n");',
  '    return 0;',
  '}',
].join('\n');
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

const expectedTerminalDemo = [
  'This message will be cleared by CSI 2J, then the cursor will return home.\n',
  '\u001b[2J\u001b[H',
  'Carriage return replaces an equal-length line:\n',
  'OLD TEXT\rNEW TEXT\n',
  'Backspace moves left, then C replaces X:\n',
  'ABX\bC\n',
  'Carriage return + CSI 2K clears the current line:\n',
  'Discarded text that will disappear',
  '\r\u001b[2K',
  'Clean replacement after CSI 2K.\n',
].join('');

test('the initial example reports three independent syntax errors and refuses execution', async () => {
  const project = {
    entry: 'main.c',
    files: [{ name: 'main.c', source: initialExampleSource }],
  };
  const analysis = analyzeSyntax(project, RUN_CONFIGURATION.options.prepare);
  assert.equal(analysis.kind, 'error', JSON.stringify(analysis));
  assert.deepEqual(analysis.diagnostics.map(({ code, file, line, column }) => [code, file, line, column]), [
    ['SYNTAX_ERROR', 'main.c', 2, 31],
    ['SYNTAX_ERROR', 'main.c', 3, 31],
    ['SYNTAX_ERROR', 'main.c', 4, 30],
  ]);
  assert.deepEqual(analysis.diagnostics.map(diagnostic =>
    initialExampleSource.split('\n')[diagnostic.line - 1][diagnostic.column - 1]), [';', ';', '4']);

  const prepared = prepare(project, RUN_CONFIGURATION.options.prepare);
  assert.equal(prepared.kind, 'prepare-error', JSON.stringify(prepared));
  assert.deepEqual(prepared.diagnostics.map(({ code, file, line, column }) => [code, file, line, column]), [
    ['SYNTAX_ERROR', 'main.c', 2, 31],
  ]);

  const file = new File([initialExampleSource], 'main.c', { type: 'text/x-c' });
  const result = await runFile(file, RUN_CONFIGURATION.options);
  assert.equal(result.kind, 'prepare-error', JSON.stringify(result));
  assert.deepEqual(result.diagnostics.map(({ line, column }) => [line, column]), [[2, 31]]);
  assert.equal(result.metrics.executeMs, 0, 'execution does not start after syntax errors');
});

test('a separate terminal demonstration preserves raw output bytes and debug snapshots', async () => {
  const project = {
    entry: 'main.c',
    files: [{ name: 'main.c', source: terminalDemoSource }],
  };
  const file = new File([terminalDemoSource], 'main.c', { type: 'text/x-c' });
  const runResult = await runFile(file, RUN_CONFIGURATION.options);
  assert.equal(runResult.kind, 'terminated', JSON.stringify(runResult));
  assert.equal(runResult.mainReturn, 0);
  assert.equal(runResult.exitCode, 0);
  assert.equal(new TextDecoder().decode(runResult.stdout), expectedTerminalDemo);
  assert.deepEqual(runResult.stderr, new Uint8Array());

  const prepared = prepare(project, RUN_CONFIGURATION.options.prepare);
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));

  const session = createDebugSession(prepared.program, RUN_CONFIGURATION.options.execute);
  let result;
  for (let index = 0; index < 100; index += 1) {
    const progress = session.resume();
    if (progress.kind !== 'paused') {
      result = progress;
      break;
    }
  }
  assert.ok(result, 'The example did not finish within 100 debug steps.');
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(new TextDecoder().decode(result.stdout), expectedTerminalDemo);
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
  assert.ok(result, 'The debug session did not reach a terminal state within 1,000 pauses.');
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
  assert.deepEqual(result.stdout, new Uint8Array());
  assert.deepEqual(result.stderr, new Uint8Array());
  const heapCreates = events.filter(event => event.kind === 'object-create' && event.duration === 'heap');
  const heapDeletes = events.filter(event => event.kind === 'object-delete' && event.duration === 'heap');
  assert.equal(heapCreates.length, 4, 'the three initial allocations and the allocation after free produce real heap objects');
  assert.equal(heapDeletes.length, heapCreates.length, 'the example frees every heap block before it terminates');
  assert.deepEqual(heapCreates.map(event => event.size), [8, 20, 36, 12]);
  assert.ok(heapCreates.every(event => event.origin === 'heap' && event.frameId === null && event.scopeId === null));

  const liveHeap = new Map();
  for (const event of events.filter(event => event.duration === 'heap')) {
    if (event.kind === 'object-create') {
      assert.equal(event.addressVirtual % BigInt(VIRTUAL_HEAP_LAYOUT.alignmentBytes), 0n, 'the heap base preserves malloc alignment');
      const start = event.addressVirtual;
      const end = start + BigInt(event.size);
      assert.ok(start >= VIRTUAL_HEAP_LAYOUT.start);
      assert.ok(end <= VIRTUAL_HEAP_LAYOUT.endExclusive);
      for (const other of liveHeap.values()) {
        const otherStart = other.addressVirtual;
        const otherEnd = otherStart + BigInt(other.size);
        assert.ok(end <= otherStart || otherEnd <= start, 'live heap blocks do not share bytes');
      }
      liveHeap.set(event.allocationId, event);
      continue;
    }

    const created = liveHeap.get(event.allocationId);
    assert.ok(created, 'free deletes a heap allocation that was still live');
    assert.equal(event.objectId, created.objectId);
    assert.equal(event.addressVirtual, created.addressVirtual);
    assert.equal(event.size, created.size);
    assert.ok(created.sequence < event.sequence);
    liveHeap.delete(event.allocationId);
  }
  assert.equal(liveHeap.size, 0, 'the heap is empty after the final free');

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
      assert.ok(created, `Snapshot ${object.id} comes from a real object-create event`);
      assert.equal(object.address, `0x${created.addressVirtual.toString(16)}`);
      assert.equal(object.size, created.size);
    }
  }

  const initialCreates = heapCreates.slice(0, 3);
  const initialIds = initialCreates.map(event => event.allocationId);
  const beforeReleaseIndex = heapSnapshots.findIndex(snapshot =>
    initialIds.every(id => snapshot.some(object => object.id === id)));
  assert.ok(beforeReleaseIndex >= 0, 'the three distinct blocks appear together before the first free');
  const beforeRelease = heapSnapshots[beforeReleaseIndex];
  const medium = initialCreates.find(event => event.size === 20);
  assert.ok(medium);
  const mediumRelease = heapDeletes.find(event => event.allocationId === medium.allocationId);
  assert.ok(mediumRelease);
  const afterReleaseIndex = heapSnapshots.findIndex((snapshot, index) =>
    index > beforeReleaseIndex
      && !snapshot.some(object => object.id === medium.allocationId)
      && initialIds.filter(id => id !== medium.allocationId).every(id => snapshot.some(object => object.id === id)));
  assert.ok(afterReleaseIndex > beforeReleaseIndex, 'free removes the middle block from the snapshot by its real identity');
  assert.ok(beforeRelease.some(object => object.id === medium.allocationId), 'the prior historical snapshot retains the released object');
  const replacement = heapCreates[3];
  assert.ok(replacement);
  const afterReplacement = heapSnapshots.slice(afterReleaseIndex + 1)
    .find(snapshot => snapshot.some(object => object.id === replacement.allocationId));
  assert.ok(afterReplacement, 'the later allocation appears with its own identity');
  assert.ok(!afterReplacement.some(object => object.id === medium.allocationId));
  assert.deepEqual(
    new Set(afterReplacement.map(object => object.id)),
    new Set([...initialIds.filter(id => id !== medium.allocationId), replacement.allocationId]),
  );
  assert.equal(heapSnapshots.at(-1).length, 0, 'the final snapshot confirms that every block has disappeared');
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
      'P4 macros, conditional, #undef, and argv: ok',
      'P4 static inline, K&R, and va_copy: ok',
      'P4 output value:42',
      'P4 printf/snprintf and virtual binary files: ok',
      'P4 string, ctype, errno, inttypes, and assert: ok',
      '',
    ].join('\n'));
    assert.deepEqual(result.stderr, new Uint8Array());
  }
});
