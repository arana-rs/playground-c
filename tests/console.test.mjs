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
      stdout: bytes('output: café\n'),
      stderr: bytes('warning'),
    },
  });
  assert.equal(text, 'output: café\nstderr:\nwarning\nexit code: 42');
});

test('console keeps partial streams when execution ends with a diagnostic or limit', () => {
  const runtimeError = formatConsole({
    status: 'finished',
    result: {
      kind: 'runtime-error',
      diagnostics: [{ code: 'DIV_ZERO', message: 'Integer division or remainder by zero: undefined behavior in C11.', file: 'main.c', line: 9, column: 3 }],
      metrics,
      stdout: bytes('partial'),
      stderr: bytes('detail\n'),
    },
  });
  assert.equal(runtimeError, 'partial\nstderr:\ndetail\nRuntime error:\nmain.c:9:3: Integer division or remainder by zero: undefined behavior in C11.');

  const limited = formatConsole({
    status: 'finished',
    result: {
      kind: 'limit',
      stage: 'execute',
      resource: 'maxIOBytes',
      limit: 4,
      diagnostics: [{ code: 'LIMIT_EXCEEDED', message: 'maxIOBytes limit exceeded: 4.', file: 'main.c', line: 1, column: 1 }],
      metrics,
      stdout: bytes('hell'),
      stderr: new Uint8Array(),
    },
  });
  assert.equal(limited, 'hell\nExecution stopped: the input and output data limit was reached (4 bytes allowed). This budget covers data that the program can read and write.\nmain.c:1:1');

  const instructionLimit = formatConsole({
    status: 'finished',
    result: {
      kind: 'limit',
      stage: 'execute',
      resource: 'maxInstructions',
      limit: 100_000,
      diagnostics: [{ code: 'LIMIT_EXCEEDED', message: 'maxInstructions limit exceeded: 100000.', file: 'main.c', line: 1, column: 28 }],
      metrics: { ...metrics, instructionCount: 100_001 },
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    },
  });
  assert.equal(instructionLimit, 'Execution stopped: the execution steps limit was reached (100,000 steps allowed; 100,001 were counted). Check for long loops or recursion; a valid calculation can also exceed this budget.\nmain.c:1:28');
  assert.doesNotMatch(instructionLimit, /maxInstructions/);
});

test('console colors output by source and keeps program text that resembles a diagnostic', () => {
  const imitation = 'Execution stopped: the execution steps limit was reached.';
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
      diagnostics: [{ code: 'LIMIT_EXCEEDED', message: 'maxInstructions limit exceeded: 100000.', file: 'main.c', line: 4, column: 5 }],
      metrics: { ...metrics, instructionCount: 100_001 },
      stdout: bytes('........'),
      stderr: new Uint8Array(),
    },
  };
  const limitedSegments = formatConsoleSegments(limitedState);
  assert.deepEqual(limitedSegments.map(({ tone }) => tone), ['program', 'warning']);
  assert.equal(limitedSegments[0].text, '........');
  assert.match(limitedSegments[1].text, /Execution stopped/u);
  assert.match(limitedSegments[1].text, /main\.c:4:5/u);
  assert.equal(limitedSegments.map(({ text }) => text).join(''), formatConsole(limitedState));

  const transcriptSegments = formatConsoleSegments({
    status: 'running',
    inputRequestId: 1,
    transcript: [
      { stream: 'stdout', text: 'output' },
      { stream: 'stdin', text: 'input\n' },
      { stream: 'stderr', text: 'warning' },
      { stream: 'system', text: '\n[EOF]\n' },
    ],
  });
  assert.equal(transcriptSegments.map(({ text }) => text).join(''), 'outputinput\nstderr:\nwarning\n[EOF]\n');
  assert.deepEqual(transcriptSegments.map(({ tone }) => tone), ['program', 'system']);
});

test('console frames preparation diagnostics and distinguishes worker failures, timeout and user cancellation', () => {
  const preparationError = formatConsole({
    status: 'finished',
    result: {
      kind: 'prepare-error',
      diagnostics: [{ code: 'PREPROCESSOR_ERROR', message: 'Virtual header «missing.h» was not found.', file: 'main.c', line: 1, column: 1 }],
      metrics,
    },
  });
  assert.equal(preparationError, 'Could not prepare the program:\nmain.c:1:1: Virtual header «missing.h» was not found.');
  assert.equal(formatConsole({
    status: 'error',
    file: 'main.c',
    reason: 'run',
    message: 'The execution engine stopped unexpectedly.',
  }), 'The execution engine failed while processing "main.c": The execution engine stopped unexpectedly.');
  assert.equal(formatConsole({ status: 'timeout', file: 'main.c', timeoutMs: 10_000 }),
    'The 10 s time limit expired while starting, reading, preparing, or running "main.c"; execution stopped. Check for slow code such as loops or recursion. A valid program may also need more time.');
  assert.equal(formatConsole({ status: 'cancelled' }), 'Execution cancelled by the user.');
});

test('console status follows runner outcomes without treating a nonzero exit as an error', () => {
  assert.deepEqual(getConsoleStatus({ status: 'idle' }), { key: 'ready', tone: 'ready' });
  assert.deepEqual(getConsoleStatus({ status: 'running' }), { key: 'running', tone: 'running' });
  assert.deepEqual(getConsoleStatus({ status: 'cancelled' }), { key: 'cancelled', tone: 'cancelled' });
  assert.deepEqual(getConsoleStatus({ status: 'timeout', file: 'main.c', timeoutMs: 10_000 }), {
    key: 'timedOut', tone: 'stopped',
  });
  assert.deepEqual(getConsoleStatus({ status: 'error', file: 'main.c', reason: 'run', message: 'failed' }), {
    key: 'error', tone: 'error',
  });
  assert.deepEqual(getConsoleStatus({
    status: 'finished',
    result: {
      kind: 'terminated', exitCode: 42, rawExitStatus: 42, mainReturn: 42, metrics,
      stdout: new Uint8Array(), stderr: new Uint8Array(),
    },
  }), { key: 'finished', tone: 'finished' });
  assert.deepEqual(getConsoleStatus({
    status: 'finished',
    result: { kind: 'runtime-error', diagnostics: [], metrics },
  }), { key: 'error', tone: 'error' });
  assert.deepEqual(getConsoleStatus({
    status: 'finished',
    result: { kind: 'limit', stage: 'execute', resource: 'maxInstructions', limit: 10, diagnostics: [], metrics },
  }), { key: 'stopped', tone: 'stopped' });
});
