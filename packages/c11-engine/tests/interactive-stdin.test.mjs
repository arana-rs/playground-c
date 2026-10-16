import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionSession, execute, prepare } from '../dist/core/index.js';
import { decodeBytes, fixtureProject, prepareProject } from './p4-test-helpers.mjs';

const makeSession = (program, options) => createExecutionSession(program, options);

test('a scanf generator suspends after its prompt and resumes once with partial writes and %n preserved', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'interactive-scan.c'));
  const session = makeSession(program);

  const prompt = session.resume();
  assert.equal(prompt.kind, 'input-needed');
  assert.equal(decodeBytes(prompt.stdout), 'Number: ');
  assert.deepEqual(prompt.stderr, new Uint8Array());

  session.appendStdin(new TextEncoder().encode('12 '));
  const partial = session.resume();
  assert.equal(partial.kind, 'input-needed');
  assert.equal(decodeBytes(partial.stdout), 'Number: ');

  session.appendStdin(new TextEncoder().encode('34\n'));
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), 'Number: first=12 consumed=2 second=34 assigned=2 calls=1\n');
  assert.ok(result.metrics.instructionCount >= partial.metrics.instructionCount);
});

test('successive scanf and fscanf calls consume one submitted line at a time without losing buffered bytes', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'interactive-multiple-scans.c'));
  const session = makeSession(program);

  const firstPrompt = session.resume();
  assert.equal(firstPrompt.kind, 'input-needed');
  assert.equal(decodeBytes(firstPrompt.stdout), 'First: ');

  session.appendStdin(new TextEncoder().encode('41\n'));
  const secondPrompt = session.resume();
  assert.equal(secondPrompt.kind, 'input-needed');
  assert.equal(decodeBytes(secondPrompt.stdout), 'First: first=41 count=1\nSecond: ');

  session.appendStdin(new TextEncoder().encode('52\n'));
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), 'First: first=41 count=1\nSecond: second=52 count=1\n');
});

test('a later %s scanf skips a leftover newline and waits for the next line', () => {
  const program = prepareProject(prepare, {
    entry: 'interactive-scan-leftover.c',
    files: [{
      name: 'interactive-scan-leftover.c',
      source: '#include <stdio.h>\nint main(void) { int first = 0; int second = 0; char word[8] = { 0 }; printf("Number 1: "); int first_count = scanf("%d", &first); printf("Number 2: "); int second_count = scanf("%d", &second); printf("Word: "); int word_count = scanf("%7s", word); printf("values=%d,%d word=%s scans=%d,%d,%d\\n", first, second, word, first_count, second_count, word_count); return 0; }',
    }],
  });
  const session = makeSession(program);
  assert.equal(decodeBytes(session.resume().stdout), 'Number 1: ');

  session.appendStdin(new TextEncoder().encode('12 34\n'));
  const wordPrompt = session.resume();
  assert.equal(wordPrompt.kind, 'input-needed');
  assert.equal(decodeBytes(wordPrompt.stdout), 'Number 1: Number 2: Word: ');

  session.appendStdin(new TextEncoder().encode('hello\n'));
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), 'Number 1: Number 2: Word: values=12,34 word=hello scans=1,1,1\n');

  const batchResult = execute(program, { io: { stdin: '12 34\nhello\n' } });
  assert.equal(batchResult.kind, 'terminated', JSON.stringify(batchResult));
  assert.equal(decodeBytes(batchResult.stdout), 'Number 1: Number 2: Word: values=12,34 word=hello scans=1,1,1\n');
});

test('a numeric token and %2c conversion can cross byte chunks without losing bytes', () => {
  const numberProgram = prepareProject(prepare, {
    entry: 'split-number.c',
    files: [{ name: 'split-number.c', source: '#include <stdio.h>\nint main(void) { int n = 0; printf("N: "); scanf("%d", &n); printf("%d\\n", n); return 0; }' }],
  });
  const numberSession = makeSession(numberProgram);
  assert.equal(numberSession.resume().kind, 'input-needed');
  numberSession.appendStdin(new TextEncoder().encode('4'));
  const splitNumber = numberSession.resume();
  assert.equal(splitNumber.kind, 'input-needed');
  numberSession.appendStdin(new TextEncoder().encode('2\n'));
  const numberResult = numberSession.resume();
  assert.equal(numberResult.kind, 'terminated', JSON.stringify(numberResult));
  assert.equal(decodeBytes(numberResult.stdout), 'N: 42\n');

  const characterProgram = prepareProject(prepare, {
    entry: 'split-character.c',
    files: [{ name: 'split-character.c', source: '#include <stdio.h>\nint main(void) { char pair[2]; printf("C: "); scanf("%2c", pair); printf("%c%c", pair[0], pair[1]); return 0; }' }],
  });
  const characterSession = makeSession(characterProgram);
  assert.equal(characterSession.resume().kind, 'input-needed');
  characterSession.appendStdin(new Uint8Array([0xc3]));
  assert.equal(characterSession.resume().kind, 'input-needed');
  characterSession.appendStdin(new Uint8Array([0xa9]));
  const characterResult = characterSession.resume();
  assert.equal(characterResult.kind, 'terminated', JSON.stringify(characterResult));
  assert.deepEqual(characterResult.stdout, new Uint8Array([67, 58, 32, 0xc3, 0xa9]));
});

test('getchar, getc, fgetc, fgets and fread keep their reader state across suspensions', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'interactive-stream-readers.c'));
  const session = makeSession(program, { io: { stdin: new Uint8Array([65, 66, 67]) } });

  const firstPause = session.resume();
  assert.equal(firstPause.kind, 'input-needed');
  session.appendStdin(new TextEncoder().encode('xy'));
  assert.equal(session.resume().kind, 'input-needed');
  session.appendStdin(new TextEncoder().encode('z'));
  const freadPause = session.resume();
  assert.equal(freadPause.kind, 'input-needed');
  session.appendStdin(new TextEncoder().encode('qr'));
  assert.equal(session.resume().kind, 'input-needed');
  session.appendStdin(new TextEncoder().encode('s'));
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), 'chars=ABC line=xyz fread=3:qrs\n');
});

test('stdin stays pending while open, then sticky EOF consumes buffered bytes and needs no further request', () => {
  const program = prepareProject(prepare, fixtureProject('.', 'interactive-eof.c'));
  const session = makeSession(program);
  assert.equal(session.resume().kind, 'input-needed');

  session.appendStdin(new Uint8Array([81]));
  assert.equal(session.resume().kind, 'input-needed');
  session.endStdin();
  session.endStdin();
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), '81,-1,-1,1\n');

  const eofBeforeRun = makeSession(program);
  eofBeforeRun.endStdin();
  const eofResult = eofBeforeRun.resume();
  assert.equal(eofResult.kind, 'terminated', JSON.stringify(eofResult));
  assert.equal(decodeBytes(eofResult.stdout), '-1,-1,-1,1\n');

  const batchResult = execute(program);
  assert.equal(batchResult.kind, 'terminated', JSON.stringify(batchResult));
  assert.equal(decodeBytes(batchResult.stdout), '-1,-1,-1,1\n');
});

test('fread retains a short typed-byte buffer and writes it only after sticky EOF', () => {
  const program = prepareProject(prepare, {
    entry: 'interactive-fread-eof.c',
    files: [{ name: 'interactive-fread-eof.c', source: '#include <stdio.h>\nint main(void) { unsigned char data[4] = { 0, 0, 0, 0 }; size_t n = fread(data, 1, 4, stdin); printf("%d:%d:%d\\n", (int)n, data[0], data[1]); return 0; }' }],
  });
  const session = makeSession(program);
  assert.equal(session.resume().kind, 'input-needed');

  session.appendStdin(new Uint8Array([81, 82]));
  const shortRead = session.resume();
  assert.equal(shortRead.kind, 'input-needed');
  session.endStdin();
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), '2:81:82\n');
});

test('instruction budget remains cumulative across a suspended read', () => {
  const program = prepareProject(prepare, {
    entry: 'interactive-instruction-limit.c',
    files: [{ name: 'interactive-instruction-limit.c', source: '#include <stdio.h>\nint main(void) { int value = getchar(); return value; }' }],
  });
  const baseline = makeSession(program).resume();
  assert.equal(baseline.kind, 'input-needed');

  const limited = makeSession(program, { limits: { maxInstructions: baseline.metrics.instructionCount } });
  const waiting = limited.resume();
  assert.equal(waiting.kind, 'input-needed');
  assert.equal(waiting.metrics.instructionCount, baseline.metrics.instructionCount);
  limited.appendStdin(new Uint8Array([65]));
  const result = limited.resume();
  assert.equal(result.kind, 'limit', JSON.stringify(result));
  assert.equal(result.resource, 'maxInstructions');
});

test('an append that exceeds maxIOBytes returns a limit on resume and retains prompt output', () => {
  const program = prepareProject(prepare, {
    entry: 'interactive-limit.c',
    files: [{ name: 'interactive-limit.c', source: '#include <stdio.h>\nint main(void) { int n; printf("> "); scanf("%d", &n); return 0; }' }],
  });
  const session = makeSession(program, { limits: { maxIOBytes: 2 } });
  const waiting = session.resume();
  assert.equal(waiting.kind, 'input-needed');
  assert.equal(decodeBytes(waiting.stdout), '> ');

  session.appendStdin(new TextEncoder().encode('7\n'));
  const result = session.resume();
  assert.equal(result.kind, 'limit', JSON.stringify(result));
  assert.equal(result.stage, 'execute');
  assert.equal(result.resource, 'maxIOBytes');
  assert.equal(decodeBytes(result.stdout), '> ');
});

test('runtime errors after resumed input preserve earlier stdout and execution budgets', () => {
  const program = prepareProject(prepare, {
    entry: 'interactive-error.c',
    files: [{ name: 'interactive-error.c', source: '#include <stdio.h>\nint main(void) { printf("Ready: "); int value = getchar(); return 1 / (value - \'x\'); }' }],
  });
  const session = makeSession(program);
  const waiting = session.resume();
  assert.equal(waiting.kind, 'input-needed');
  session.appendStdin(new Uint8Array([120]));
  const result = session.resume();
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'DIVISION_BY_ZERO');
  assert.equal(decodeBytes(result.stdout), 'Ready: ');
  assert.ok(result.metrics.instructionCount > waiting.metrics.instructionCount);
});
