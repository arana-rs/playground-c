import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalPresentation } from '../src/components/terminalPresentation.ts';
import { formatConsole, formatConsoleSegments } from '../src/execution/useRunner.ts';

const ESC = '\u001b';
const output = (text, stream = 'stdout') => ({ tone: 'program', text, role: 'output', stream });
const input = text => ({ tone: 'program', text, role: 'input', stream: 'stdin' });
const protectedOutput = (text, tone = 'error') => ({ tone, text, role: 'protected', stream: 'system' });
const screenText = snapshot => snapshot.screen.map(segment => segment.text).join('');
const protectedText = snapshot => snapshot.protectedSegments.map(segment => segment.text).join('');
const render = (...segments) => new TerminalPresentation().update(segments);

test('carriage return overwrites from the start and backspace moves without deleting', () => {
  assert.equal(screenText(render(output('abc\rX'))), 'Xbc');
  assert.equal(screenText(render(output('abc\bX'))), 'abX');
});

test('CRLF, ordinary long output, and tabs retain readable text', () => {
  assert.equal(screenText(render(output('first\r\nsecond\tvalue'))), 'first\nsecond  value');
  const longText = 'x'.repeat(1_500);
  assert.equal(screenText(render(output(longText))), longText);
});

test('CSI K supports erase-to-end, erase-through-cursor, and erase-line modes', () => {
  assert.equal(screenText(render(output(`abcdef${ESC}[1;3H${ESC}[K`))), 'ab');
  assert.equal(screenText(render(output(`abcdef${ESC}[1;3H${ESC}[1K`))), '   def');
  assert.equal(screenText(render(output(`abcdef${ESC}[2K`))), '');
});

test('CSI J supports erase-to-end, erase-from-start, and erase-display while H/f position the cursor', () => {
  assert.equal(screenText(render(output(`one\ntwo\nthree${ESC}[1;2H${ESC}[J`))), 'o\n');
  assert.equal(screenText(render(output(`one\ntwo\nthree${ESC}[2;2H${ESC}[1J`))), '\n  o\nthree');
  assert.equal(screenText(render(output(`old\ncontent${ESC}[2J${ESC}[Hfresh`))), 'fresh');
  assert.equal(screenText(render(output(`abc\nDEF${ESC}[1;2fX`))), 'aXc\nDEF');
  assert.equal(screenText(render(output(`ab${ESC}[HXY`))), 'XY');
  assert.equal(screenText(render(output(`ab${ESC}[fXY`))), 'XY');
  assert.equal(screenText(render(output(`abc\nDEF${ESC}[2JX`))), '\n   X');
});

test('incremental updates retain incomplete CSI state and process only the added suffix', () => {
  const presentation = new TerminalPresentation();
  const first = [{ ...output(`ready${ESC}[`) }];
  assert.equal(screenText(presentation.update(first)), 'ready');
  first[0].text += '2K';
  assert.equal(screenText(presentation.update(first)), '');
  first[0].text += 'after';
  assert.equal(screenText(presentation.update(first)), '     after');
});

test('unsupported and incomplete escapes are suppressed without hiding later text', () => {
  assert.equal(screenText(render(output(`safe${ESC}[?25l text${ESC}c${ESC}(B done`))), 'safe text done');
  assert.equal(screenText(render(output(`before${ESC}Xafter`))), 'beforeafter');

  const presentation = new TerminalPresentation();
  assert.equal(screenText(presentation.update([output(`old${ESC}[12`)], 1)), 'old');
  assert.equal(screenText(presentation.update([output('new')], 2)), 'new');
});

test('huge CSI coordinates stay bounded, and normal output is not truncated', () => {
  const outputText = `start${ESC}[9999999999999999999999999999999999;9999999999999999999999999999999999H`;
  assert.equal(screenText(render(output(outputText))), 'start');
});

test('stdin is literal, stdout and stderr share the screen, and protected diagnostics survive clear-screen', () => {
  assert.equal(screenText(render(output('keep'), input(`${ESC}[2J`), output('done'))), `keep${ESC}[2Jdone`);

  const snapshot = render(
    output('prompt: ', 'stdout'),
    input('user input\n'),
    output('warning\n', 'stderr'),
    output(`${ESC}[2J${ESC}[Hfinished`, 'stdout'),
    protectedOutput('Runtime error: diagnostic'),
  );

  assert.equal(screenText(snapshot), 'finished');
  assert.equal(protectedText(snapshot), 'Runtime error: diagnostic');
  assert.equal(snapshot.protectedSegments[0]?.tone, 'error');
});

test('formatter retains stdout, stderr, stdin, and system roles without changing their text', () => {
  const segments = formatConsoleSegments({
    status: 'running',
    transcript: [
      { stream: 'stdout', text: 'first' },
      { stream: 'stderr', text: 'warning' },
      { stream: 'stdin', text: 'value\n' },
      { stream: 'system', text: 'Runtime error: stopped', tone: 'error' },
    ],
    inputRequestId: null,
  });

  assert.deepEqual(segments.map(segment => [segment.role, segment.stream]), [
    ['output', 'stdout'],
    ['output', 'stderr'],
    ['input', 'stdin'],
    ['protected', 'system'],
  ]);
  assert.equal(segments.map(segment => segment.text).join(''), 'firstwarningvalue\nRuntime error: stopped');
  assert.equal(formatConsole({
    status: 'running',
    transcript: [
      { stream: 'stdout', text: 'first' },
      { stream: 'stderr', text: 'warning' },
    ],
    inputRequestId: null,
  }), 'first\nstderr:\nwarning');
  assert.equal(segments[1]?.tone, 'program');
  assert.equal(segments[3]?.tone, 'error');
});

test('hostile-looking output remains text and source segments are not mutated', () => {
  const original = output('</span><img src=x onerror=alert(1)>');
  const source = [original];
  const snapshot = new TerminalPresentation().update(source);
  assert.equal(screenText(snapshot), original.text);
  assert.equal(original.text, '</span><img src=x onerror=alert(1)>');
  assert.deepEqual(source, [original]);
});

test('terminal presentation leaves the RunResult output bytes unchanged', () => {
  const stdout = new TextEncoder().encode(`raw\rbytes${ESC}[2J`);
  const stderr = new TextEncoder().encode('warning');
  const stdoutBefore = stdout.slice();
  const stderrBefore = stderr.slice();
  const segments = formatConsoleSegments({
    status: 'finished',
    result: {
      kind: 'terminated',
      exitCode: 0,
      rawExitStatus: 0,
      mainReturn: 0,
      metrics: {
        readMs: 0, prepareMs: 0, executeMs: 0, totalMs: 0,
        sourceChars: 0, tokenCount: 0, preprocessSteps: 0,
        instructionCount: 0, peakMemoryBytes: 0,
      },
      stdout,
      stderr,
    },
  });

  new TerminalPresentation().update(segments);
  assert.deepEqual(stdout, stdoutBefore);
  assert.deepEqual(stderr, stderrBefore);
});
