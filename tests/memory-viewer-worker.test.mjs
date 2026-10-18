import assert from 'node:assert/strict';
import test from 'node:test';

test('the real Worker prepares main, advances by line, and drains only lifecycle events', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-worker-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 73, fileName: 'main.c',
      source: 'int main(void) {\n  int value = 1;\n  int pending;\n  value = value + 1;\n  return value;\n}\nint global_value = 23;\nchar *global_text = "h\\n";\n',
    } });
    assert.equal(responses[0].type, 'debug-ready');
    assert.deepEqual(responses[0].location, { file: 'main.c', line: 2, column: responses[0].location.column });
    assert.ok(responses[0].location.column > 0);
    assert.ok(responses[0].events.some(event => event.kind === 'scope-enter' && event.scopeName === 'main'));
    assert.deepEqual(responses[0].stackScalars, [], 'entering main does not publish future declarations');
    assert.ok(!responses[0].events.some(event => event.kind === 'object-create' && (event.name === 'value' || event.name === 'pending')));
    const staticValue = responses[0].staticObjects.find(object => object.name === 'global_value');
    assert.ok(staticValue, 'debug-ready includes actual global scalars');
    assert.equal(staticValue.origin, 'variable');
    assert.equal(staticValue.displayValue, '23');
    assert.equal(staticValue.size, 4);
    assert.match(staticValue.address, /^0x[\da-f]+$/iu);
    assert.ok(
      responses[0].staticObjects.every(object => object.origin !== 'string-literal'),
      'the Worker does not publish string previews in staticObjects',
    );
    const stringLiteral = responses[0].arrays.find(object => object.origin === 'string-literal');
    assert.ok(stringLiteral, 'debug-ready includes the string literal as an array root');
    assert.equal(stringLiteral.type, 'char[3]');
    assert.equal(stringLiteral.size, 3);
    assert.equal(stringLiteral.status, 'available');
    assert.deepEqual(stringLiteral.elements.map(element => element.displayValue), ["'h'", "'\\n'", "'\\0'"]);

    scope.onmessage({ data: { type: 'debug-step', jobId: 73, requestId: 1 } });
    assert.equal(responses[1].type, 'debug-progress');
    assert.equal(responses[1].requestId, 1);
    assert.equal(responses[1].progress.kind, 'paused');
    assert.equal(responses[1].progress.location.line, 3);
    const valueCreateEvent = responses[1].events.find(event => event.kind === 'object-create' && event.name === 'value');
    assert.ok(valueCreateEvent, 'the declaration publishes the object when its initializer executes');
    assert.equal(responses[1].stackScalars.length, 1);
    const initializedValue = responses[1].stackScalars[0];
    assert.equal(initializedValue.name, 'value');
    assert.equal(initializedValue.id, valueCreateEvent.allocationId);
    assert.equal(initializedValue.scopeId, valueCreateEvent.scopeId);
    assert.equal(initializedValue.type, 'int');
    assert.equal(initializedValue.size, 4);
    assert.equal(typeof initializedValue.id, 'number');
    assert.equal(typeof initializedValue.scopeId, 'number');
    assert.equal(typeof initializedValue.frameId, 'number');
    assert.match(initializedValue.address, /^0x[\da-f]+$/iu);
    assert.equal(initializedValue.initialized, true);
    assert.equal(initializedValue.displayValue, '1', 'the snapshot corresponds to the new location');

    scope.onmessage({ data: { type: 'debug-step', jobId: 73, requestId: 2 } });
    assert.equal(responses[2].progress.location.line, 4);
    const pendingCreateEvent = responses[2].events.find(event => event.kind === 'object-create' && event.name === 'pending');
    assert.ok(pendingCreateEvent, 'a declaration without an initializer also creates an observable object');
    assert.equal(responses[2].stackScalars.length, 2);
    assert.equal(responses[2].stackScalars[0].id, valueCreateEvent.allocationId);
    assert.equal(responses[2].stackScalars[0].displayValue, '1');
    assert.equal(responses[2].stackScalars[1].id, pendingCreateEvent.allocationId);
    assert.equal(responses[2].stackScalars[1].initialized, false);
    assert.equal(responses[2].stackScalars[1].displayValue, '?');

    scope.onmessage({ data: { type: 'debug-step', jobId: 73, requestId: 3 } });
    assert.equal(responses[3].progress.location.line, 5);
    assert.equal(responses[3].stackScalars[0].displayValue, '2');
    assert.equal(responses[3].stackScalars[1].displayValue, '?');

    scope.onmessage({ data: { type: 'debug-step', jobId: 73, requestId: 4 } });
    assert.equal(responses[4].progress.kind, 'terminated');
    assert.deepEqual(responses[4].stackScalars, [], 'terminal inspection reflects normal scope exit');
    assert.ok(responses.flatMap(response => response.events ?? []).every(event => !('value' in event)));
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the Worker retains scalar values, exact conversions, and scopes across pauses', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-scalar-mutations-test');
    const source = [
      'static int visits;',
      'int main(void) {',
      '    int uninitialized;',
      '    uninitialized = 0;',
      '    int value = 4;',
      '    value = value + 1;',
      '    value += 2;',
      '    int previous_increment = value++;',
      '    int increment_result = ++value;',
      '    int previous_decrement = value--;',
      '    int decrement_result = --value;',
      '    long exact = 9007199254740993L;',
      '    int result = exact > 0 ? value : 0;',
      '    {',
      '        int result = 10;',
      '        result--;',
      '    }',
      '    visits += 1;',
      '    return 0;',
      '}',
    ].join('\n');
    scope.onmessage({ data: { type: 'debug-start', jobId: 74, fileName: 'main.c', source } });

    assert.equal(responses[0].type, 'debug-ready');
    assert.equal(responses[0].staticObjects.find(object => object.name === 'visits')?.displayValue, '0');

    let terminal;
    for (let requestId = 1; requestId <= 40; requestId += 1) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 74, requestId } });
      const response = responses.at(-1);
      assert.equal(response.type, 'debug-progress');
      if (response.progress.kind !== 'paused') {
        terminal = response;
        break;
      }
    }
    assert.ok(terminal, 'the example reaches a terminal state within the step budget');
    assert.equal(terminal.progress.kind, 'terminated');

    const steps = responses.slice(1);
    const snapshots = name => steps.flatMap(response => response.stackScalars.filter(scalar => scalar.name === name));
    assert.ok(snapshots('uninitialized').some(scalar => !scalar.initialized && scalar.displayValue === '?'));
    assert.ok(snapshots('uninitialized').some(scalar => scalar.initialized && scalar.displayValue === '0'), 'a simple assignment initializes the object');

    const valueChanges = [];
    for (const response of steps) {
      const scalar = response.stackScalars.find(item => item.name === 'value');
      if (scalar && valueChanges.at(-1) !== scalar.displayValue) valueChanges.push(scalar.displayValue);
    }
    assert.deepEqual(valueChanges, ['4', '5', '7', '8', '9', '8', '7']);
    for (const [name, value] of [
      ['previous_increment', '7'],
      ['increment_result', '9'],
      ['previous_decrement', '9'],
      ['decrement_result', '7'],
    ]) {
      assert.ok(snapshots(name).some(scalar => scalar.displayValue === value), `${name} retains ${value}`);
    }
    assert.ok(snapshots('exact').some(scalar => scalar.type === 'long' && scalar.displayValue === '9007199254740993'));

    const shadowed = steps.find(response => response.stackScalars.filter(scalar => scalar.name === 'result').length === 2);
    assert.ok(shadowed, 'the nested scope shows both declarations with the same name');
    const results = shadowed.stackScalars.filter(scalar => scalar.name === 'result');
    assert.deepEqual(results.map(scalar => scalar.displayValue), ['7', '10']);
    assert.notEqual(results[0].id, results[1].id);
    assert.notEqual(results[0].scopeId, results[1].scopeId);
    const afterShadowScope = steps.slice(steps.indexOf(shadowed) + 1)
      .find(response => response.stackScalars.filter(scalar => scalar.name === 'result').length === 1);
    assert.equal(afterShadowScope?.stackScalars.find(scalar => scalar.name === 'result')?.displayValue, '7');

    assert.ok(steps.some(response => response.staticObjects.find(object => object.name === 'visits')?.displayValue === '1'));
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the Worker reports ++ on an uninitialized automatic and retains its state', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-uninitialized-increment-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 75, fileName: 'main.c',
      source: 'int main(void) {\n    int uninitialized;\n    uninitialized++;\n    return 0;\n}\n',
    } });
    assert.equal(responses[0].type, 'debug-ready');

    scope.onmessage({ data: { type: 'debug-step', jobId: 75, requestId: 1 } });
    assert.equal(responses[1].progress.kind, 'paused');
    assert.deepEqual(
      responses[1].stackScalars.map(({ initialized, displayValue }) => ({ initialized, displayValue })),
      [{ initialized: false, displayValue: '?' }],
    );

    scope.onmessage({ data: { type: 'debug-step', jobId: 75, requestId: 2 } });
    const failed = responses[2];
    assert.equal(failed.progress.kind, 'runtime-error');
    assert.ok(failed.progress.diagnostics.some(diagnostic => diagnostic.code === 'UNINITIALIZED_READ'));
    assert.deepEqual(
      failed.stackScalars.map(({ initialized, displayValue }) => ({ initialized, displayValue })),
      [{ initialized: false, displayValue: '?' }],
      'the failed increment does not initialize or modify the object',
    );
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the Worker inspects live heap blocks by address, size, and allocation identity', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-heap-test');
    const source = [
      '#include <stdlib.h>',
      'int main(void) {',
      '    int *values = malloc(4 * sizeof(int));',
      '    if (values == NULL) return 1;',
      '    values[0] = 21;',
      '    free(values);',
      '    return 0;',
      '}',
    ].join('\n');
    scope.onmessage({ data: { type: 'debug-start', jobId: 121, fileName: 'main.c', source } });

    assert.equal(responses[0].type, 'debug-ready');
    assert.deepEqual(responses[0].heapObjects, []);
    for (let requestId = 1; requestId <= 12 && responses.at(-1).progress?.kind !== 'terminated'; requestId += 1) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 121, requestId } });
      assert.equal(responses.at(-1).type, 'debug-progress');
    }

    const createEvents = responses.flatMap(response => response.events ?? [])
      .filter(event => event.kind === 'object-create' && event.origin === 'heap');
    const deleteEvents = responses.flatMap(response => response.events ?? [])
      .filter(event => event.kind === 'object-delete' && event.origin === 'heap');
    assert.equal(createEvents.length, 1);
    assert.equal(deleteEvents.length, 1);

    const firstLiveResponse = responses.find(response => response.heapObjects?.length > 0);
    const block = firstLiveResponse.heapObjects[0];
    assert.deepEqual(block, {
      id: createEvents[0].allocationId,
      address: `0x${createEvents[0].addressVirtual.toString(16)}`,
      size: 16,
      origin: 'heap',
    });

    const freedResponse = responses.find(response => response.events?.some(event => event.kind === 'object-delete' && event.origin === 'heap'));
    assert.deepEqual(freedResponse.heapObjects, [], 'free removes the block from active inspection');
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the Worker retains suspended scanf, its partial effects, and incremental output', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-stdin-continuation-test');
    const source = [
      '#include <stdio.h>',
      'int main(void) {',
      '    int values[2] = {0, 0};',
      '    int index = 0;',
      '    int second = 0;',
      '    int count = 0;',
      '    printf("prompt> ");',
      '    count = scanf("%d %d", &values[index++], &second);',
      '    printf("values=%d,%d index=%d count=%d\\n", values[0], second, index, count);',
      '    return 0;',
      '}',
    ].join('\n');
    scope.onmessage({ data: { type: 'debug-start', jobId: 111, fileName: 'main.c', source } });
    assert.equal(responses[0].type, 'debug-ready');

    let requestId = 1;
    let firstWait;
    while (requestId <= 12) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 111, requestId } });
      const progress = responses.at(-1);
      assert.equal(progress.type, 'debug-progress');
      if (progress.progress.kind === 'input-needed') {
        firstWait = progress;
        break;
      }
      assert.equal(progress.progress.kind, 'paused', 'the VM remains alive until it reaches scanf');
      requestId += 1;
    }
    assert.ok(firstWait, 'scanf requests input without ending the session');
    assert.ok(firstWait.inputRequestId > 0);
    assert.equal('stdout' in firstWait.progress, false, 'input-needed does not clone accumulated output snapshots');
    assert.equal('stderr' in firstWait.progress, false);
    const waitIndex = responses.indexOf(firstWait);
    const firstOutput = responses.findIndex(response => response.type === 'debug-output');
    assert.ok(firstOutput >= 0 && firstOutput < waitIndex, 'the prompt arrives before the input-needed event');
    assert.equal(new TextDecoder().decode(responses[firstOutput].chunk), 'prompt> ');

    const stepRequestId = firstWait.requestId;
    const firstInputToken = firstWait.inputRequestId;
    const responseCount = responses.length;
    scope.onmessage({ data: {
      type: 'debug-stdin', jobId: 111, requestId: stepRequestId, inputRequestId: firstInputToken + 1,
      bytes: new TextEncoder().encode('999\n'),
    } });
    assert.equal(responses.length, responseCount, 'a stale input token does not resume scanf');

    scope.onmessage({ data: {
      type: 'debug-stdin', jobId: 111, requestId: stepRequestId, inputRequestId: firstInputToken,
      bytes: new TextEncoder().encode('12 \n'),
    } });
    const secondWait = responses.at(-1);
    assert.equal(secondWait.type, 'debug-progress');
    assert.equal(secondWait.progress.kind, 'input-needed', 'the second %d still waits for the rest of the same call');
    assert.equal('stdout' in secondWait.progress, false, 'repeated waits carry only output deltas');
    assert.equal('stderr' in secondWait.progress, false);
    assert.equal(secondWait.requestId, stepRequestId, 'the continuation retains the request for the same step');
    assert.notEqual(secondWait.inputRequestId, firstInputToken, 'the second wait has a new token');
    const array = secondWait.arrays.find(item => item.name === 'values');
    assert.equal(array.elements[0].displayValue, '12', 'the first conversion was assigned before the second wait');
    assert.equal(secondWait.stackScalars.find(item => item.name === 'index').displayValue, '1', 'the &values[index++] argument is not evaluated again');

    scope.onmessage({ data: {
      type: 'debug-stdin', jobId: 111, requestId: stepRequestId, inputRequestId: secondWait.inputRequestId,
      bytes: new TextEncoder().encode('34\n'),
    } });
    const resumed = responses.at(-1);
    assert.equal(resumed.type, 'debug-progress');
    assert.equal(resumed.progress.kind, 'paused');
    assert.equal('stdout' in resumed.progress, false, 'an intermediate pause also avoids duplicating the output prefix');
    assert.equal('stderr' in resumed.progress, false);
    assert.equal(resumed.requestId, stepRequestId);
    assert.equal(resumed.progress.location.line, 9, 'the scanf line ends and the VM pauses at the next instruction');
    assert.equal(resumed.stackScalars.find(item => item.name === 'index').displayValue, '1');

    requestId += 1;
    scope.onmessage({ data: { type: 'debug-step', jobId: 111, requestId } });
    const outputEvents = responses.filter(response => response.type === 'debug-output' && response.stream === 'stdout');
    const outputText = outputEvents.map(response => new TextDecoder().decode(response.chunk)).join('');
    assert.equal(outputText, 'prompt> values=12,34 index=1 count=2\n', 'each output byte is sent once and in order');
    assert.ok(outputEvents.every((response, index) => index === 0 || response.sequence > outputEvents[index - 1].sequence));

    requestId += 1;
    scope.onmessage({ data: { type: 'debug-step', jobId: 111, requestId } });
    assert.equal(responses.at(-1).progress.kind, 'terminated');
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('the Worker transmits the real origin of parameters and locals in the same scope', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-parameter-origin-test');
    const source = [
      'int helper(int count, float ratio, _Bool enabled) {',
      '  int local = count;',
      '  return local + (int)ratio + enabled;',
      '}',
      'int main(void) {',
      '  return helper(2, 1.5f, 1);',
      '}',
    ].join('\n');
    scope.onmessage({ data: { type: 'debug-start', jobId: 91, fileName: 'main.c', source } });

    assert.equal(responses[0].type, 'debug-ready');
    assert.deepEqual(responses[0].stackScalars, []);

    const events = [];
    let helperScopeEntryResponse;
    let localResponse;
    let terminalResponse;
    for (let requestId = 1; requestId <= 12; requestId += 1) {
      scope.onmessage({ data: { type: 'debug-step', jobId: 91, requestId } });
      const response = responses.at(-1);
      assert.equal(response.type, 'debug-progress');
      events.push(...response.events);

      if (!helperScopeEntryResponse && response.events.some(event => event.kind === 'scope-enter' && event.scopeName === 'helper')) {
        helperScopeEntryResponse = response;
      }
      if (!localResponse && response.stackScalars.some(scalar => scalar.name === 'local')) localResponse = response;
      if (response.progress.kind === 'terminated') {
        terminalResponse = response;
        break;
      }
    }

    assert.ok(helperScopeEntryResponse, 'the Worker publishes entry to helper root scope');
    const helperScopeEntry = helperScopeEntryResponse.events.find(event => event.kind === 'scope-enter' && event.scopeName === 'helper');
    const parametersAtEntry = helperScopeEntryResponse.stackScalars.filter(scalar => scalar.frameId === helperScopeEntry.frameId);
    assert.deepEqual(parametersAtEntry.map(({ name, origin }) => [name, origin]), [
      ['count', 'parameter'],
      ['ratio', 'parameter'],
      ['enabled', 'parameter'],
    ]);
    assert.equal(parametersAtEntry.some(scalar => scalar.name === 'local'), false, 'entry does not invent locals before their declaration executes');
    assert.deepEqual(parametersAtEntry.map(scalar => scalar.displayValue), ['2', '1.5', '1']);

    assert.ok(localResponse, 'the Worker adds the local after its declaration executes');
    const local = localResponse.stackScalars.find(scalar => scalar.name === 'local');
    const count = localResponse.stackScalars.find(scalar => scalar.name === 'count');
    assert.equal(local.origin, 'variable');
    assert.equal(local.type, count.type, 'the parameter and local share int type');
    assert.equal(local.scopeId, count.scopeId, 'the parameter and local belong to helper root scope');
    assert.equal(local.frameId, count.frameId);
    assert.notEqual(local.id, count.id);

    const helperFrameId = count.frameId;
    const helperObjects = events.filter(event => event.kind === 'object-create' && event.frameId === helperFrameId);
    const helperScope = events.find(event => event.kind === 'scope-enter' && event.frameId === helperFrameId);
    assert.ok(helperScope);
    assert.ok(parametersAtEntry.every(scalar => scalar.scopeId === helperScope.scopeId));
    const helperCreates = helperObjects.filter(event => ['count', 'ratio', 'enabled', 'local'].includes(event.name));
    assert.deepEqual(helperCreates.map(event => [event.name, event.origin]), [
      ['count', 'parameter'],
      ['ratio', 'parameter'],
      ['enabled', 'parameter'],
      ['local', 'variable'],
    ]);
    const helperFrameEntry = events.find(event => event.kind === 'frame-enter' && event.frameId === helperFrameId);
    const firstParameterCreate = helperCreates.find(event => event.origin === 'parameter');
    const localCreate = helperCreates.find(event => event.name === 'local');
    assert.ok(helperFrameEntry.sequence < helperScope.sequence && helperScope.sequence < firstParameterCreate.sequence);
    assert.ok(firstParameterCreate.sequence < localCreate.sequence, 'origin metadata follows the actual creation order');

    assert.ok(terminalResponse, 'the call terminates within the fixture step budget');
    assert.deepEqual(terminalResponse.stackScalars, []);
    const deletesById = new Map(events.filter(event => event.kind === 'object-delete').map(event => [event.allocationId, event]));
    for (const created of helperCreates) {
      const deleted = deletesById.get(created.allocationId);
      assert.ok(deleted, `${created.name} closes the same object that was created`);
      assert.equal(deleted.frameId, created.frameId);
      assert.equal(deleted.scopeId, created.scopeId);
      assert.equal(deleted.origin, created.origin);
    }
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});
