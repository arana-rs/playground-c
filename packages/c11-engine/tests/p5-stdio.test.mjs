import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, execute, prepare } from '../dist/core/index.js';
import { decodeBytes, executeTerminated, fixtureSourceFor, prepareProject } from './p4-test-helpers.mjs';

const project = (entry) => ({ entry, files: [{ name: entry, source: fixtureSourceFor('p5', entry) }] });

test('stdio publishes the narrow function set and deterministic buffering profile', () => {
  assert.equal(CAPABILITIES.stdioFunctions.length, 45);
  for (const name of ['freopen', 'remove', 'rename', 'tmpfile', 'tmpnam', 'fgetpos', 'fsetpos', 'vfprintf', 'vfscanf', 'vprintf', 'vscanf', 'vsprintf', 'vsnprintf', 'vsscanf']) {
    assert.ok(CAPABILITIES.stdioFunctions.includes(name), name);
  }
  assert.deepEqual(CAPABILITIES.stdioMacros, ['EOF', 'BUFSIZ', 'FOPEN_MAX', 'FILENAME_MAX', 'L_tmpnam', 'TMP_MAX', 'SEEK_SET', 'SEEK_CUR', 'SEEK_END', '_IOFBF', '_IOLBF', '_IONBF', 'stdin', 'stdout', 'stderr']);
  assert.match(CAPABILITIES.stdioBufferingProfile, /synchronous-output/);
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
