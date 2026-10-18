import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, createDebugSession, createExecutionSession, execute, prepare } from '../dist/core/index.js';
import { decodeBytes, executeTerminated, fixtureSourceFor, prepareProject } from './p4-test-helpers.mjs';

const project = (entry) => ({ entry, files: [{ name: entry, source: fixtureSourceFor('p5', entry) }] });
const inlineProgram = (entry, source) => prepareProject(prepare, { entry, files: [{ name: entry, source }] });

test('stdio publishes the narrow function set and deterministic buffering profile', () => {
  assert.equal(CAPABILITIES.stdioFunctions.length, 45);
  for (const name of ['freopen', 'remove', 'rename', 'tmpfile', 'tmpnam', 'fgetpos', 'fsetpos', 'vfprintf', 'vfscanf', 'vprintf', 'vscanf', 'vsprintf', 'vsnprintf', 'vsscanf']) {
    assert.ok(CAPABILITIES.stdioFunctions.includes(name), name);
  }
  assert.deepEqual(CAPABILITIES.stdioMacros, ['EOF', 'BUFSIZ', 'FOPEN_MAX', 'FILENAME_MAX', 'L_tmpnam', 'TMP_MAX', 'SEEK_SET', 'SEEK_CUR', 'SEEK_END', '_IOFBF', '_IOLBF', '_IONBF', 'stdin', 'stdout', 'stderr']);
  assert.match(CAPABILITIES.stdioBufferingProfile, /default-_IONBF-immediate-output/);
  assert.match(CAPABILITIES.stdioBufferingProfile, /_IOFBF-_IOLBF-_IONBF/);
  assert.match(CAPABILITIES.stdioBufferingProfile, /engine-owns-internal-queue/);
  assert.match(CAPABILITIES.stdioFileProfile, /fpos_t is long byte offset/);
});

test('all v* stdio families reuse va_list traversal and preserve independent va_copy cursors', () => {
  const program = prepareProject(prepare, project('stdio-varargs.c'));
  const result = executeTerminated(execute, program, { io: { stdin: '31 32' } }, 0);
  assert.equal(decodeBytes(result.stdout), 'v=27\n');
  assert.equal(decodeBytes(result.stderr), 'e=ok');
});

test('a v* routine makes its passed va_list indeterminate until va_end', () => {
  const program = prepareProject(prepare, {
    entry: 'indeterminate-va-list.c',
    files: [{ name: 'indeterminate-va-list.c', source: `#include <stdarg.h>
#include <stdio.h>
static int invalid_after_vprintf(const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  vprintf(format, arguments);
  return va_arg(arguments, int);
}
int main(void) { return invalid_after_vprintf("%d", 7); }
` }],
  });
  const result = execute(program);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'INVALID_VA_LIST');
});

test('virtual files support exclusive open, rename/remove, temporary files and byte positions', () => {
  const program = prepareProject(prepare, project('stdio-virtual-files.c'));
  executeTerminated(execute, program, undefined, 0);
});

test('freopen rebinds canonical streams, fclose closes standard streams, and perror accepts NULL', () => {
  const program = prepareProject(prepare, project('stdio-standard-redirection.c'));
  executeTerminated(execute, program, { io: { files: [{ name: 'stdin.dat', data: '42' }] } }, 0);
});

test('explicit full buffering hides pending bytes and flushes them at capacity, fflush(NULL), fseek and fclose', () => {
  const program = inlineProgram('stdio-buffered-files.c', `#include <stdio.h>
#include <string.h>
int main(void) {
  FILE *writer = fopen("buffered.dat", "w+");
  FILE *reader = fopen("buffered.dat", "r");
  char buffer[3];
  if (!writer || !reader) return 1;
  if (setvbuf(writer, buffer, _IOFBF, sizeof buffer) != 0) return 2;
  if (fputs("ab", writer) != 0 || ftell(writer) != 2) return 3;
  if (fgetc(reader) != EOF || !feof(reader)) return 4;
  if (fputc('c', writer) != 'c' || ftell(writer) != 3) return 5;
  rewind(reader);
  if (fgetc(reader) != 'a' || fgetc(reader) != 'b' || fgetc(reader) != 'c') return 6;
  fpos_t position;
  if (fgetpos(writer, &position) != 0 || fsetpos(writer, &position) != 0) return 7;
  if (fputc('d', writer) != 'd' || fflush(NULL) != 0) return 8;
  rewind(reader);
  if (fgetc(reader) != 'a' || fgetc(reader) != 'b' || fgetc(reader) != 'c' || fgetc(reader) != 'd') return 9;
  if (fseek(writer, 3, SEEK_SET) != 0 || fputc('D', writer) != 'D') return 10;
  if (fclose(writer) != 0) return 11;
  rewind(reader);
  char bytes[5] = { 0 };
  if (fread(bytes, 1, 4, reader) != 4 || memcmp(bytes, "abcD", 4) != 0) return 12;
  if (fclose(reader) != 0) return 13;
  FILE *append = fopen("buffered.dat", "a");
  FILE *observer = fopen("buffered.dat", "r");
  char appendBuffer[3];
  if (!append || !observer) return 14;
  if (setvbuf(append, appendBuffer, _IOFBF, sizeof appendBuffer) != 0) return 15;
  if (fputc('e', append) != 'e' || fputc('f', append) != 'f' || ftell(append) != 6) return 16;
  if (fseek(observer, 4, SEEK_SET) != 0 || fgetc(observer) != EOF || !feof(observer)) return 17;
  if (fflush(append) != 0) return 18;
  rewind(observer);
  char appended[7] = { 0 };
  if (fread(appended, 1, 6, observer) != 6 || memcmp(appended, "abcDef", 6) != 0) return 19;
  if (fclose(append) != 0 || fclose(observer) != 0) return 20;
  FILE *update = fopen("update.dat", "w+");
  if (!update || setvbuf(update, 0, _IOFBF, 4) != 0) return 21;
  if (fputc('u', update) != 'u' || fflush(update) != 0) return 22;
  if (fgetc(update) != EOF || !feof(update)) return 23;
  if (ungetc('Q', update) != 'Q' || feof(update) || fgetc(update) != 'Q') return 24;
  if (fseek(update, 0, SEEK_SET) != 0 || fgetc(update) != 'u') return 25;
  if (fgetc(update) != EOF || !feof(update) || fputc('v', update) != 'v') return 26;
  if (fclose(update) != 0) return 27;
  FILE *updated = fopen("update.dat", "r");
  char updatedBytes[3] = { 0 };
  if (!updated || fread(updatedBytes, 1, 2, updated) != 2 || memcmp(updatedBytes, "uv", 2) != 0) return 28;
  if (fclose(updated) != 0) return 29;
  return 0;
}
`);
  executeTerminated(execute, program, undefined, 0);
});

test('explicit line buffering flushes on newline and before an interactive stdin read', () => {
  const program = inlineProgram('stdio-line-buffering.c', `#include <stdio.h>
int main(void) {
  if (setvbuf(stdout, 0, _IOLBF, 16) != 0) return 1;
  printf("line\\n");
  printf("prompt");
  fprintf(stderr, "error");
  return getchar() == 'x' ? 0 : 2;
}
`);
  const session = createExecutionSession(program);
  const waiting = session.resume();
  assert.equal(waiting.kind, 'input-needed');
  assert.equal(decodeBytes(waiting.stdout), 'line\nprompt');
  assert.equal(decodeBytes(waiting.stderr), 'error');
  session.appendStdin(new TextEncoder().encode('x'));
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), 'line\nprompt');

  const debugSession = createDebugSession(program);
  let debugProgress = debugSession.resume();
  for (let index = 0; debugProgress.kind === 'paused' && index < 500; index += 1) {
    debugProgress = debugSession.resume();
  }
  assert.equal(debugProgress.kind, 'input-needed', JSON.stringify(debugProgress));
  assert.equal(decodeBytes(debugProgress.stdout), 'line\nprompt');
  assert.equal(decodeBytes(debugProgress.stderr), 'error');
});

test('default stdout and stderr remain immediately visible while waiting for stdin', () => {
  const program = inlineProgram('stdio-default-buffering.c', `#include <stdio.h>
int main(void) {
  printf("stdout");
  fprintf(stderr, "stderr");
  return getchar() == 'x' ? 0 : 1;
}
`);
  const session = createExecutionSession(program);
  const waiting = session.resume();
  assert.equal(waiting.kind, 'input-needed');
  assert.equal(decodeBytes(waiting.stdout), 'stdout');
  assert.equal(decodeBytes(waiting.stderr), 'stderr');
  session.appendStdin(new TextEncoder().encode('x'));
  assert.equal(session.resume().kind, 'terminated');
});

test('setvbuf validates mode, size and writable custom-buffer range without consuming failed attempts', () => {
  const program = inlineProgram('stdio-buffer-validation.c', `#include <stdio.h>
int main(void) {
  char buffer[2];
  if (setvbuf(stdout, buffer, 3, 2) == 0) return 1;
  if (setvbuf(stdout, buffer, _IOFBF, 3) == 0) return 2;
  if (setvbuf(stdout, buffer, _IOFBF, 0) == 0) return 3;
  if (setvbuf(stdout, buffer, _IOFBF, sizeof buffer) != 0) return 4;
  if (setvbuf(stdout, 0, _IONBF, 0) == 0) return 5;
  printf("buffered");
  if (setvbuf(stdout, 0, _IONBF, 0) == 0) return 6;
  return 0;
}
`);
  const result = execute(program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
  assert.equal(decodeBytes(result.stdout), 'buffered');
});

test('setbuf selects full buffering for a custom buffer and null buffering for NULL', () => {
  const customProgram = inlineProgram('stdio-setbuf-custom.c', `#include <stdio.h>
int main(void) {
  char buffer[BUFSIZ];
  setbuf(stdout, buffer);
  printf("hidden");
  return getchar() == 'x' ? 0 : 1;
}
`);
  const session = createExecutionSession(customProgram);
  const waiting = session.resume();
  assert.equal(waiting.kind, 'input-needed');
  assert.deepEqual(waiting.stdout, new Uint8Array());
  session.appendStdin(new TextEncoder().encode('x'));
  const result = session.resume();
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(decodeBytes(result.stdout), 'hidden');

  const nullProgram = inlineProgram('stdio-setbuf-null.c', `#include <stdio.h>
int main(void) {
  setbuf(stdout, 0);
  printf("visible");
  return getchar() == 'x' ? 0 : 1;
}
`);
  const nullSession = createExecutionSession(nullProgram);
  const nullWaiting = nullSession.resume();
  assert.equal(nullWaiting.kind, 'input-needed');
  assert.equal(decodeBytes(nullWaiting.stdout), 'visible');
  nullSession.appendStdin(new TextEncoder().encode('x'));
  assert.equal(nullSession.resume().kind, 'terminated');
});

test('normal return and exit flush after atexit handlers; quick_exit and runtime errors do not flush', () => {
  const normalProgram = inlineProgram('stdio-normal-flush.c', `#include <stdio.h>
#include <stdlib.h>
static void finish(void) { printf("exit"); }
int main(void) {
  if (setvbuf(stdout, 0, _IOFBF, 16) != 0) return 1;
  if (atexit(finish) != 0) return 2;
  printf("main");
  return 0;
}
`);
  const normal = execute(normalProgram);
  assert.equal(normal.kind, 'terminated', JSON.stringify(normal));
  assert.equal(decodeBytes(normal.stdout), 'mainexit');

  const exitProgram = inlineProgram('stdio-exit-flush.c', `#include <stdio.h>
#include <stdlib.h>
int main(void) {
  if (setvbuf(stdout, 0, _IOFBF, 16) != 0) return 1;
  printf("exit");
  exit(0);
}
`);
  const exited = execute(exitProgram);
  assert.equal(exited.kind, 'terminated', JSON.stringify(exited));
  assert.equal(decodeBytes(exited.stdout), 'exit');

  const quickProgram = inlineProgram('stdio-quick-flush.c', `#include <stdio.h>
#include <stdlib.h>
int main(void) {
  if (setvbuf(stdout, 0, _IOFBF, 16) != 0) return 1;
  printf("hidden");
  quick_exit(0);
}
`);
  const quick = execute(quickProgram);
  assert.equal(quick.kind, 'terminated', JSON.stringify(quick));
  assert.deepEqual(quick.stdout, new Uint8Array());

  const errorProgram = inlineProgram('stdio-error-no-flush.c', `#include <stdio.h>
int main(void) {
  int *pointer = 0;
  if (setvbuf(stdout, 0, _IOFBF, 16) != 0) return 1;
  printf("hidden");
  *pointer = 1;
  return 0;
}
`);
  const failed = execute(errorProgram);
  assert.equal(failed.kind, 'runtime-error', JSON.stringify(failed));
  assert.deepEqual(failed.stdout, new Uint8Array());
});

test('full-buffer capacities of one and two preserve split UTF-8 output bytes', () => {
  const oneByteProgram = inlineProgram('stdio-buffer-size-one.c', `#include <stdio.h>
int main(void) {
  if (setvbuf(stdout, 0, _IOFBF, 1) != 0) return 1;
  return fwrite(u8"\\u00f1", 1, 2, stdout) == 2 ? 0 : 2;
}
`);
  const oneByte = execute(oneByteProgram);
  assert.equal(oneByte.kind, 'terminated', JSON.stringify(oneByte));
  assert.deepEqual(oneByte.stdout, new Uint8Array([0xc3, 0xb1]));

  const twoByteProgram = inlineProgram('stdio-buffer-size-two.c', `#include <stdio.h>
int main(void) {
  if (setvbuf(stdout, 0, _IOFBF, 2) != 0) return 1;
  return fwrite(u8"\\u20ac", 1, 3, stdout) == 3 ? 0 : 2;
}
`);
  const twoByte = execute(twoByteProgram);
  assert.equal(twoByte.kind, 'terminated', JSON.stringify(twoByte));
  assert.deepEqual(twoByte.stdout, new Uint8Array([0xe2, 0x82, 0xac]));
  assert.equal(decodeBytes(twoByte.stdout), '€');
});
