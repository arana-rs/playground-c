import assert from 'node:assert/strict';
import test from 'node:test';

test('el Worker real prepara main, avanza por líneas y drena solo eventos lifecycle', async () => {
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
    assert.deepEqual(responses[0].stackScalars, [], 'entrar en main no publica declaraciones futuras');
    assert.ok(!responses[0].events.some(event => event.kind === 'object-create' && (event.name === 'value' || event.name === 'pending')));
    const staticValue = responses[0].staticObjects.find(object => object.name === 'global_value');
    assert.ok(staticValue, 'debug-ready incluye los escalares globales reales');
    assert.equal(staticValue.origin, 'variable');
    assert.equal(staticValue.displayValue, '23');
    assert.equal(staticValue.size, 4);
    assert.match(staticValue.address, /^0x[\da-f]+$/iu);
    assert.ok(
      responses[0].staticObjects.every(object => object.origin !== 'string-literal'),
      'el Worker no publica previews de literales en staticObjects',
    );
    const stringLiteral = responses[0].arrays.find(object => object.origin === 'string-literal');
    assert.ok(stringLiteral, 'debug-ready incluye el literal como raíz de array');
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
    assert.ok(valueCreateEvent, 'la declaración publica el objeto al ejecutar su inicializador');
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
    assert.equal(initializedValue.displayValue, '1', 'la instantánea corresponde a la ubicación nueva');

    scope.onmessage({ data: { type: 'debug-step', jobId: 73, requestId: 2 } });
    assert.equal(responses[2].progress.location.line, 4);
    const pendingCreateEvent = responses[2].events.find(event => event.kind === 'object-create' && event.name === 'pending');
    assert.ok(pendingCreateEvent, 'la declaración sin inicializador también crea un objeto observable');
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
    assert.deepEqual(responses[4].stackScalars, [], 'la inspección terminal refleja el cierre normal del scope');
    assert.ok(responses.flatMap(response => response.events ?? []).every(event => !('value' in event)));
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('el Worker conserva los valores escalares, las conversiones exactas y los scopes entre pausas', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-scalar-mutations-test');
    const source = [
      'static int visitas;',
      'int main(void) {',
      '    int pendiente;',
      '    pendiente = 0;',
      '    int valor = 4;',
      '    valor = valor + 1;',
      '    valor += 2;',
      '    int anterior_incremento = valor++;',
      '    int resultado_incremento = ++valor;',
      '    int anterior_decremento = valor--;',
      '    int resultado_decremento = --valor;',
      '    long exacto = 9007199254740993L;',
      '    int resultado = exacto > 0 ? valor : 0;',
      '    {',
      '        int resultado = 10;',
      '        resultado--;',
      '    }',
      '    visitas += 1;',
      '    return 0;',
      '}',
    ].join('\n');
    scope.onmessage({ data: { type: 'debug-start', jobId: 74, fileName: 'main.c', source } });

    assert.equal(responses[0].type, 'debug-ready');
    assert.equal(responses[0].staticObjects.find(object => object.name === 'visitas')?.displayValue, '0');

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
    assert.ok(terminal, 'la demo llega a un estado terminal dentro del presupuesto de pasos');
    assert.equal(terminal.progress.kind, 'terminated');

    const steps = responses.slice(1);
    const snapshots = name => steps.flatMap(response => response.stackScalars.filter(scalar => scalar.name === name));
    assert.ok(snapshots('pendiente').some(scalar => !scalar.initialized && scalar.displayValue === '?'));
    assert.ok(snapshots('pendiente').some(scalar => scalar.initialized && scalar.displayValue === '0'), 'la asignación simple inicializa el objeto');

    const valueChanges = [];
    for (const response of steps) {
      const scalar = response.stackScalars.find(item => item.name === 'valor');
      if (scalar && valueChanges.at(-1) !== scalar.displayValue) valueChanges.push(scalar.displayValue);
    }
    assert.deepEqual(valueChanges, ['4', '5', '7', '8', '9', '8', '7']);
    for (const [name, value] of [
      ['anterior_incremento', '7'],
      ['resultado_incremento', '9'],
      ['anterior_decremento', '9'],
      ['resultado_decremento', '7'],
    ]) {
      assert.ok(snapshots(name).some(scalar => scalar.displayValue === value), `${name} conserva ${value}`);
    }
    assert.ok(snapshots('exacto').some(scalar => scalar.type === 'long' && scalar.displayValue === '9007199254740993'));

    const shadowed = steps.find(response => response.stackScalars.filter(scalar => scalar.name === 'resultado').length === 2);
    assert.ok(shadowed, 'el scope anidado muestra ambas declaraciones con el mismo nombre');
    const results = shadowed.stackScalars.filter(scalar => scalar.name === 'resultado');
    assert.deepEqual(results.map(scalar => scalar.displayValue), ['7', '10']);
    assert.notEqual(results[0].id, results[1].id);
    assert.notEqual(results[0].scopeId, results[1].scopeId);
    const afterShadowScope = steps.slice(steps.indexOf(shadowed) + 1)
      .find(response => response.stackScalars.filter(scalar => scalar.name === 'resultado').length === 1);
    assert.equal(afterShadowScope?.stackScalars.find(scalar => scalar.name === 'resultado')?.displayValue, '7');

    assert.ok(steps.some(response => response.staticObjects.find(object => object.name === 'visitas')?.displayValue === '1'));
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('el Worker diagnostica ++ sobre una automática sin inicializar y conserva su estado', async () => {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/memory/memory.worker.ts?memory-viewer-uninitialized-increment-test');
    scope.onmessage({ data: {
      type: 'debug-start', jobId: 75, fileName: 'main.c',
      source: 'int main(void) {\n    int pendiente;\n    pendiente++;\n    return 0;\n}\n',
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
      'el incremento fallido no inicializa ni modifica el objeto',
    );
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('el Worker inspecciona bloques heap vivos por dirección, tamaño e identidad de asignación', async () => {
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
    assert.deepEqual(freedResponse.heapObjects, [], 'free retira el bloque de la inspección activa');
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('el Worker conserva el scanf suspendido, sus efectos parciales y la salida incremental', async () => {
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
      assert.equal(progress.progress.kind, 'paused', 'la VM permanece viva hasta alcanzar scanf');
      requestId += 1;
    }
    assert.ok(firstWait, 'scanf solicita entrada sin finalizar la sesión');
    assert.ok(firstWait.inputRequestId > 0);
    assert.equal('stdout' in firstWait.progress, false, 'input-needed no clona snapshots de salida acumulados');
    assert.equal('stderr' in firstWait.progress, false);
    const waitIndex = responses.indexOf(firstWait);
    const firstOutput = responses.findIndex(response => response.type === 'debug-output');
    assert.ok(firstOutput >= 0 && firstOutput < waitIndex, 'el prompt llega antes del evento input-needed');
    assert.equal(new TextDecoder().decode(responses[firstOutput].chunk), 'prompt> ');

    const stepRequestId = firstWait.requestId;
    const firstInputToken = firstWait.inputRequestId;
    const responseCount = responses.length;
    scope.onmessage({ data: {
      type: 'debug-stdin', jobId: 111, requestId: stepRequestId, inputRequestId: firstInputToken + 1,
      bytes: new TextEncoder().encode('999\n'),
    } });
    assert.equal(responses.length, responseCount, 'un token de entrada obsoleto no reanuda el scanf');

    scope.onmessage({ data: {
      type: 'debug-stdin', jobId: 111, requestId: stepRequestId, inputRequestId: firstInputToken,
      bytes: new TextEncoder().encode('12 \n'),
    } });
    const secondWait = responses.at(-1);
    assert.equal(secondWait.type, 'debug-progress');
    assert.equal(secondWait.progress.kind, 'input-needed', 'el segundo %d sigue esperando el resto de la misma llamada');
    assert.equal('stdout' in secondWait.progress, false, 'los waits repetidos transportan solo deltas de salida');
    assert.equal('stderr' in secondWait.progress, false);
    assert.equal(secondWait.requestId, stepRequestId, 'la continuación conserva la solicitud del mismo paso');
    assert.notEqual(secondWait.inputRequestId, firstInputToken, 'el segundo wait tiene un token nuevo');
    const array = secondWait.arrays.find(item => item.name === 'values');
    assert.equal(array.elements[0].displayValue, '12', 'la primera conversión ya fue asignada antes de la segunda espera');
    assert.equal(secondWait.stackScalars.find(item => item.name === 'index').displayValue, '1', 'el argumento &values[index++] no se evalúa otra vez');

    scope.onmessage({ data: {
      type: 'debug-stdin', jobId: 111, requestId: stepRequestId, inputRequestId: secondWait.inputRequestId,
      bytes: new TextEncoder().encode('34\n'),
    } });
    const resumed = responses.at(-1);
    assert.equal(resumed.type, 'debug-progress');
    assert.equal(resumed.progress.kind, 'paused');
    assert.equal('stdout' in resumed.progress, false, 'una pausa intermedia tampoco duplica el prefijo de salida');
    assert.equal('stderr' in resumed.progress, false);
    assert.equal(resumed.requestId, stepRequestId);
    assert.equal(resumed.progress.location.line, 9, 'la línea scanf termina y la VM se detiene en la instrucción siguiente');
    assert.equal(resumed.stackScalars.find(item => item.name === 'index').displayValue, '1');

    requestId += 1;
    scope.onmessage({ data: { type: 'debug-step', jobId: 111, requestId } });
    const outputEvents = responses.filter(response => response.type === 'debug-output' && response.stream === 'stdout');
    const outputText = outputEvents.map(response => new TextDecoder().decode(response.chunk)).join('');
    assert.equal(outputText, 'prompt> values=12,34 index=1 count=2\n', 'cada byte producido se envía una sola vez y en orden');
    assert.ok(outputEvents.every((response, index) => index === 0 || response.sequence > outputEvents[index - 1].sequence));

    requestId += 1;
    scope.onmessage({ data: { type: 'debug-step', jobId: 111, requestId } });
    assert.equal(responses.at(-1).progress.kind, 'terminated');
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});

test('el Worker transmite el origen real de parámetros y locales en el mismo scope', async () => {
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

    assert.ok(helperScopeEntryResponse, 'el Worker publica la entrada al scope raíz de helper');
    const helperScopeEntry = helperScopeEntryResponse.events.find(event => event.kind === 'scope-enter' && event.scopeName === 'helper');
    const parametersAtEntry = helperScopeEntryResponse.stackScalars.filter(scalar => scalar.frameId === helperScopeEntry.frameId);
    assert.deepEqual(parametersAtEntry.map(({ name, origin }) => [name, origin]), [
      ['count', 'parameter'],
      ['ratio', 'parameter'],
      ['enabled', 'parameter'],
    ]);
    assert.equal(parametersAtEntry.some(scalar => scalar.name === 'local'), false, 'la entrada no inventa locales antes de ejecutar su declaración');
    assert.deepEqual(parametersAtEntry.map(scalar => scalar.displayValue), ['2', '1.5', '1']);

    assert.ok(localResponse, 'el Worker añade el local después de ejecutar su declaración');
    const local = localResponse.stackScalars.find(scalar => scalar.name === 'local');
    const count = localResponse.stackScalars.find(scalar => scalar.name === 'count');
    assert.equal(local.origin, 'variable');
    assert.equal(local.type, count.type, 'parámetro y local comparten tipo int');
    assert.equal(local.scopeId, count.scopeId, 'parámetro y local pertenecen al scope raíz de helper');
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
    assert.ok(firstParameterCreate.sequence < localCreate.sequence, 'la metadata de origen sigue el orden real de creación');

    assert.ok(terminalResponse, 'la llamada termina dentro del presupuesto de pasos de la fixture');
    assert.deepEqual(terminalResponse.stackScalars, []);
    const deletesById = new Map(events.filter(event => event.kind === 'object-delete').map(event => [event.allocationId, event]));
    for (const created of helperCreates) {
      const deleted = deletesById.get(created.allocationId);
      assert.ok(deleted, `${created.name} cierra el mismo objeto creado`);
      assert.equal(deleted.frameId, created.frameId);
      assert.equal(deleted.scopeId, created.scopeId);
      assert.equal(deleted.origin, created.origin);
    }
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
});
