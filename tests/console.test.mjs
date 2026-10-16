import assert from 'node:assert/strict';
import test from 'node:test';
import { formatConsole, formatConsoleSegments, getConsoleStatus, RUN_CONFIGURATION } from '../src/execution/useRunner.ts';

const metrics = {
  readMs: 0,
  prepareMs: 0,
  executeMs: 0,
  totalMs: 0,
  sourceChars: 0,
  tokenCount: 0,
  preprocessSteps: 0,
  instructionCount: 0,
  peakMemoryBytes: 0,
};
const bytes = (text) => new TextEncoder().encode(text);

test('Run limits include the shared I/O budget and a bounded preprocess-step budget', () => {
  assert.equal(RUN_CONFIGURATION.options.execute.limits.maxIOBytes, 1_048_576);
  assert.equal(RUN_CONFIGURATION.options.prepare.limits.maxPreprocessSteps, 1_000_000);
});

test('console decodes stdout/stderr before the exit status', () => {
  const text = formatConsole({
    status: 'finished',
    result: {
      kind: 'terminated',
      exitCode: 42,
      rawExitStatus: 42,
      mainReturn: 42,
      metrics,
      stdout: bytes('salida: café\n'),
      stderr: bytes('aviso'),
    },
  });
  assert.equal(text, 'salida: café\nstderr:\naviso\nexit code: 42');
});

test('console keeps partial streams when execution ends with a diagnostic or limit', () => {
  const runtimeError = formatConsole({
    status: 'finished',
    result: {
      kind: 'runtime-error',
      diagnostics: [{ code: 'DIV_ZERO', message: 'división por cero', file: 'main.c', line: 9, column: 3 }],
      metrics,
      stdout: bytes('parcial'),
      stderr: bytes('detalle\n'),
    },
  });
  assert.equal(runtimeError, 'parcial\nstderr:\ndetalle\nError durante la ejecución:\nmain.c:9:3: división por cero');

  const limited = formatConsole({
    status: 'finished',
    result: {
      kind: 'limit',
      stage: 'execute',
      resource: 'maxIOBytes',
      limit: 4,
      diagnostics: [{ code: 'LIMIT_EXCEEDED', message: 'límite agotado', file: 'main.c', line: 1, column: 1 }],
      metrics,
      stdout: bytes('hell'),
      stderr: new Uint8Array(),
    },
  });
  assert.equal(limited, 'hell\nLa ejecución se detuvo: se alcanzó el límite de datos de entrada y salida (4 bytes permitidos). El presupuesto cubre los datos que el programa puede leer y escribir.\nmain.c:1:1');

  const instructionLimit = formatConsole({
    status: 'finished',
    result: {
      kind: 'limit',
      stage: 'execute',
      resource: 'maxInstructions',
      limit: 100_000,
      diagnostics: [{ code: 'LIMIT_EXCEEDED', message: 'Se superó maxInstructions: límite 100000.', file: 'main.c', line: 1, column: 28 }],
      metrics: { ...metrics, instructionCount: 100_001 },
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    },
  });
  assert.equal(instructionLimit, 'La ejecución se detuvo: se alcanzó el límite de pasos de ejecución (100.000 pasos permitidos; se contabilizaron 100.001). Revisa bucles o recursión extensos; un cálculo válido también puede superar este presupuesto.\nmain.c:1:28');
  assert.doesNotMatch(instructionLimit, /maxInstructions/);
});

test('console colors output by source and keeps program text that resembles a diagnostic', () => {
  const imitation = 'La ejecución se detuvo: se alcanzó el límite de pasos de ejecución.';
  const programResult = {
    status: 'finished',
    result: {
      kind: 'terminated',
      exitCode: 0,
      rawExitStatus: 0,
      mainReturn: 0,
      metrics,
      stdout: bytes(imitation),
      stderr: new Uint8Array(),
    },
  };
  const programSegments = formatConsoleSegments(programResult);
  assert.deepEqual(programSegments.map(({ tone }) => tone), ['program', 'system']);
  assert.equal(programSegments.map(({ text }) => text).join(''), `${imitation}\nexit code: 0`);

  const limitedState = {
    status: 'finished',
    result: {
      kind: 'limit',
      stage: 'execute',
      resource: 'maxInstructions',
      limit: 100_000,
      diagnostics: [{ code: 'LIMIT_EXCEEDED', message: 'límite alcanzado', file: 'main.c', line: 4, column: 5 }],
      metrics: { ...metrics, instructionCount: 100_001 },
      stdout: bytes('........'),
      stderr: new Uint8Array(),
    },
  };
  const limitedSegments = formatConsoleSegments(limitedState);
  assert.deepEqual(limitedSegments.map(({ tone }) => tone), ['program', 'warning']);
  assert.equal(limitedSegments[0].text, '........');
  assert.match(limitedSegments[1].text, /La ejecución se detuvo/u);
  assert.match(limitedSegments[1].text, /main\.c:4:5/u);
  assert.equal(limitedSegments.map(({ text }) => text).join(''), formatConsole(limitedState));

  const transcriptSegments = formatConsoleSegments({
    status: 'running',
    inputRequestId: 1,
    transcript: [
      { stream: 'stdout', text: 'salida' },
      { stream: 'stdin', text: 'entrada\n' },
      { stream: 'stderr', text: 'aviso' },
      { stream: 'system', text: '\n[EOF]\n' },
    ],
  });
  assert.equal(transcriptSegments.map(({ text }) => text).join(''), 'salidaentrada\nstderr:\naviso\n[EOF]\n');
  assert.deepEqual(transcriptSegments.map(({ tone }) => tone), ['program', 'system']);
});

test('console frames preparation diagnostics and distinguishes worker failures, timeout and user cancellation', () => {
  const preparationError = formatConsole({
    status: 'finished',
    result: {
      kind: 'prepare-error',
      diagnostics: [{ code: 'PREPROCESSOR_ERROR', message: 'include no encontrado', file: 'main.c', line: 1, column: 1 }],
      metrics,
    },
  });
  assert.equal(preparationError, 'No se pudo preparar el programa:\nmain.c:1:1: include no encontrado');
  assert.equal(formatConsole({
    status: 'error',
    file: 'main.c',
    reason: 'run',
    message: 'El motor terminó inesperadamente.',
  }), 'El motor de ejecución falló mientras procesaba «main.c»: El motor terminó inesperadamente.');
  assert.equal(formatConsole({ status: 'timeout', file: 'main.c', timeoutMs: 10_000 }),
    'Se agotó el tiempo máximo (10 s) mientras se iniciaba, leía, preparaba o ejecutaba «main.c»; se detuvo la ejecución. Revisa código lento, como bucles o recursión; un programa válido también puede necesitar más tiempo.');
  assert.equal(formatConsole({ status: 'cancelled' }), 'Ejecución cancelada por el usuario.');
});

test('console status follows runner outcomes without treating a nonzero exit as an error', () => {
  assert.deepEqual(getConsoleStatus({ status: 'idle' }), { label: 'Listo', tone: 'ready' });
  assert.deepEqual(getConsoleStatus({ status: 'running' }), { label: 'Ejecutando', tone: 'running' });
  assert.deepEqual(getConsoleStatus({ status: 'cancelled' }), { label: 'Cancelado', tone: 'cancelled' });
  assert.deepEqual(getConsoleStatus({ status: 'timeout', file: 'main.c', timeoutMs: 10_000 }), {
    label: 'Tiempo agotado', tone: 'stopped',
  });
  assert.deepEqual(getConsoleStatus({ status: 'error', file: 'main.c', reason: 'run', message: 'falló' }), {
    label: 'Error', tone: 'error',
  });
  assert.deepEqual(getConsoleStatus({
    status: 'finished',
    result: {
      kind: 'terminated', exitCode: 42, rawExitStatus: 42, mainReturn: 42, metrics,
      stdout: new Uint8Array(), stderr: new Uint8Array(),
    },
  }), { label: 'Finalizado', tone: 'finished' });
  assert.deepEqual(getConsoleStatus({
    status: 'finished',
    result: { kind: 'runtime-error', diagnostics: [], metrics },
  }), { label: 'Error', tone: 'error' });
  assert.deepEqual(getConsoleStatus({
    status: 'finished',
    result: { kind: 'limit', stage: 'execute', resource: 'maxInstructions', limit: 10, diagnostics: [], metrics },
  }), { label: 'Detenido', tone: 'stopped' });
});
