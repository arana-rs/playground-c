import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const project = (source) => ({ entry: 'p5-stdlib-time.c', files: [{ name: 'p5-stdlib-time.c', source }] });

const compile = (source) => {
  const result = prepare(project(source));
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
};

const run = (source, expected) => {
  const result = execute(compile(source));
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected, source);
  return result;
};

test('qsort and bsearch call C comparators through the VM and retain full object representations', () => {
  run(`#include <stdlib.h>
struct Node { char tag; int key; int *payload; };
static int compare_nodes(const void *left, const void *right) {
  const struct Node *a = left, *b = right;
  return (a->key > b->key) - (a->key < b->key);
}
static int compare_ints(const void *key, const void *item) {
  int a = *(const int *)key, b = *(const int *)item;
  return (a > b) - (a < b);
}
int main(void) {
  int first = 11, second = 22;
  struct Node nodes[2] = {{'b', 2, &first}, {'a', 1, &second}};
  unsigned char *bytes = (unsigned char *)&nodes[0];
  for (int i = 1; i < 4; i++) bytes[i] = 0x11;
  bytes = (unsigned char *)&nodes[1];
  for (int i = 1; i < 4; i++) bytes[i] = 0x22;
  qsort(nodes, 2, sizeof nodes[0], compare_nodes);
  if (nodes[0].key != 1 || nodes[0].tag != 'a' || nodes[0].payload != &second) return 1;
  if (nodes[1].key != 2 || nodes[1].tag != 'b' || nodes[1].payload != &first) return 2;
  bytes = (unsigned char *)&nodes[0];
  for (int i = 1; i < 4; i++) if (bytes[i] != 0x22) return 3;
  bytes = (unsigned char *)&nodes[1];
  for (int i = 1; i < 4; i++) if (bytes[i] != 0x11) return 4;
  { int values[] = {1, 3, 5, 7}, key = 5;
    int *found = bsearch(&key, values, 4, sizeof values[0], compare_ints);
    if (found != &values[2] || *found != key) return 5;
    key = 6;
    if (bsearch(&key, values, 4, sizeof values[0], compare_ints) != 0) return 6;
  }
  return 0;
}` , 0);
});

test('stdlib allocation, integer helpers, locale C multibyte and virtual environment profile are deterministic', () => {
  const program = compile(`#include <stdlib.h>
#include <errno.h>
int main(void) {
  if (RAND_MAX != 2147483647 || MB_CUR_MAX != 1) return 1;
  if (abs(-4) != 4 || labs(-5L) != 5L || llabs(-6LL) != 6LL) return 2;
  { div_t a = div(-17, 5); ldiv_t b = ldiv(17L, -5L); lldiv_t c = lldiv(17LL, 5LL);
    if (a.quot != -3 || a.rem != -2 || b.quot != -3 || b.rem != 2 || c.quot != 3 || c.rem != 2) return 3;
  }
  { int *zeroed = calloc(4, sizeof *zeroed); if (!zeroed || zeroed[3] != 0) return 4; free(zeroed); }
  { void *aligned = aligned_alloc(16, 32); if (!aligned || ((unsigned long)aligned & 15UL)) return 5; free(aligned); }
  if (mblen("A", 1) != 1 || mblen("", 1) != 0 || mblen(0, 0) != 0) return 6;
  { char invalid[] = { (char)0xff, 0 }; if (mblen(invalid, 1) != -1 || errno != EILSEQ) return 7; }
  if (getenv("MISSING_C11_VARIABLE") != 0) return 8;
  if (system(0) != 0 || system("echo must not run") != -1 || errno != 38) return 9;
  return 0;
}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = execute(program);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 0);
  }
});

test('rand state starts deterministically and srand resets it per execution', () => {
  const program = compile(`#include <stdlib.h>
int main(void) {
  int first = rand(), second = rand();
  if (first == second || first < 0 || first > RAND_MAX || second < 0 || second > RAND_MAX) return 1;
  srand(1234U);
  { int seeded = rand(); srand(1234U); if (seeded != rand()) return 2; }
  return 0;
}`);
  const first = execute(program), second = execute(program);
  assert.equal(first.kind, 'terminated', JSON.stringify(first));
  assert.equal(second.kind, 'terminated', JSON.stringify(second));
  assert.equal(first.mainReturn, 0);
  assert.equal(second.mainReturn, 0);
});

test('time.h uses deterministic UTC conversion, normalization, formatting and timespec_get', () => {
  const program = compile(`#include <time.h>
#include <string.h>
int main(void) {
  time_t epoch = 0;
  struct tm *utc = gmtime(&epoch);
  char text[32], iso[16];
  if (!utc || utc->tm_year != 70 || utc->tm_mon != 0 || utc->tm_mday != 1 || utc->tm_wday != 4 || utc->tm_yday != 0) return 1;
  if (strftime(text, sizeof text, "%Y-%m-%d %H:%M:%S %z %Z", utc) != 29) return 2;
  if (text[0] != '1' || text[3] != '0' || text[11] != '0' || text[20] != '+') return 3;
  { struct tm normalized = { .tm_sec = 0, .tm_min = 0, .tm_hour = 0, .tm_mday = 1, .tm_mon = 12, .tm_year = 100 };
    if (mktime(&normalized) != 978307200L || normalized.tm_year != 101 || normalized.tm_mon != 0) return 4;
  }
  { struct timespec ts; if (timespec_get(&ts, TIME_UTC) != TIME_UTC || ts.tv_sec != 1704067200L || ts.tv_nsec != 0L) return 5; }
  if (time(0) != 1704067200L || time(0) != time(0) || clock() <= 0L) return 6;
  { time_t boundary = 1609459200L; struct tm *date = gmtime(&boundary);
    if (!date || strftime(iso, sizeof iso, "%G-W%V-%u", date) != 10 || strcmp(iso, "2020-W53-5")) return 8;
    boundary = 1577664000L; date = gmtime(&boundary);
    if (!date || strftime(iso, sizeof iso, "%G-W%V-%u", date) != 10 || strcmp(iso, "2020-W01-1")) return 9;
  }
  if (!asctime(utc) || !ctime(&epoch)) return 7;
  return 0;
}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = execute(program);
    assert.equal(result.kind, 'terminated', JSON.stringify(result));
    assert.equal(result.mainReturn, 0);
  }
});

test('time.h reads an injected wall clock once per call and keeps time/timespec coherent', () => {
  const program = compile(`#include <time.h>
int main(void) {
  struct timespec now;
  time_t before = time(0);
  if (timespec_get(&now, TIME_UTC) != TIME_UTC) return 1;
  if (before != 1704067200L || now.tv_sec != before || now.tv_nsec != 456000000L) return 2;
  return 0;
}`);
  const result = execute(program, undefined, {
    wallClock: { nowEpochMilliseconds: () => 1_704_067_200_456n },
  });
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
});

test('time.h observes later readings and normalizes negative epoch milliseconds', () => {
  const program = compile(`#include <time.h>
int main(void) {
  struct timespec now;
  if (time(0) != -1L) return 1;
  if (timespec_get(&now, TIME_UTC) != TIME_UTC || now.tv_sec != 1704067200L || now.tv_nsec != 456000000L) return 2;
  if (time(0) != 1704067201L) return 3;
  return 0;
}`);
  const readings = [-1n, 1_704_067_200_456n, 1_704_067_201_001n];
  let index = 0;
  const result = execute(program, undefined, {
    wallClock: { nowEpochMilliseconds: () => readings[index++] },
  });
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
  assert.equal(index, readings.length);
});

test('srand((unsigned int)time(NULL)) uses distinct injected seconds across sessions', () => {
  const program = compile(`#include <stdlib.h>
#include <time.h>
int main(void) {
  srand((unsigned int)time(0));
  return rand();
}`);
  const runAt = (milliseconds) => execute(program, undefined, {
    wallClock: { nowEpochMilliseconds: () => milliseconds },
  });
  const first = runAt(1_704_067_200_000n);
  const second = runAt(1_704_067_201_000n);
  assert.equal(first.kind, 'terminated', JSON.stringify(first));
  assert.equal(second.kind, 'terminated', JSON.stringify(second));
  assert.notEqual(first.mainReturn, second.mainReturn);
});

test('atexit handlers run in LIFO order through normal VM frames', () => {
  const program = compile(`#include <stdlib.h>
#include <stdio.h>
static void first(void) { puts("first"); }
static void second(void) { puts("second"); }
int main(void) {
  if (atexit(first) || atexit(second)) return 1;
  exit(0);
  return 99;
}`);
  const result = execute(program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(new TextDecoder().decode(result.stdout), 'second\nfirst\n');
});

test('main return and quick_exit run only the matching termination handler stack', () => {
  const normal = execute(compile(`#include <stdlib.h>
#include <stdio.h>
static void normal_handler(void) { puts("normal"); }
int main(void) { if (atexit(normal_handler)) return 1; return EXIT_SUCCESS; }`));
  assert.equal(normal.kind, 'terminated', JSON.stringify(normal));
  assert.equal(normal.mainReturn, 0);
  assert.equal(new TextDecoder().decode(normal.stdout), 'normal\n');

  const quick = execute(compile(`#include <stdlib.h>
#include <stdio.h>
static void normal_handler(void) { puts("normal"); }
static void quick_handler(void) { puts("quick"); }
int main(void) {
  if (atexit(normal_handler) || at_quick_exit(quick_handler)) return 1;
  quick_exit(EXIT_SUCCESS);
}`));
  assert.equal(quick.kind, 'terminated', JSON.stringify(quick));
  assert.equal(quick.exitCode, 0);
  assert.equal(new TextDecoder().decode(quick.stdout), 'quick\n');
});

test('_Exit and abort skip registered handlers, stop execution and preserve status', () => {
  const immediate = execute(compile(`#include <stdlib.h>
#include <stdio.h>
static void normal_handler(void) { puts("normal"); }
static void quick_handler(void) { puts("quick"); }
int main(void) {
  if (atexit(normal_handler) || at_quick_exit(quick_handler)) return 1;
  _Exit(-7);
  puts("after");
  return 99;
}`));
  assert.equal(immediate.kind, 'terminated', JSON.stringify(immediate));
  assert.equal(immediate.exitCode, 249);
  assert.equal(immediate.rawExitStatus, -7);
  assert.equal(immediate.stdout.length, 0);

  const aborted = execute(compile(`#include <stdlib.h>
#include <stdio.h>
static void normal_handler(void) { puts("normal"); }
int main(void) {
  if (atexit(normal_handler)) return 1;
  abort();
  puts("after");
  return 99;
}`));
  assert.equal(aborted.kind, 'terminated', JSON.stringify(aborted));
  assert.equal(aborted.exitCode, 134);
  assert.equal(aborted.rawExitStatus, 134);
  assert.equal(aborted.stdout.length, 0);
});

test('nested exit preserves status and callbacks registered during unwind run next', () => {
  const result = execute(compile(`#include <stdlib.h>
#include <stdio.h>
static void first(void) { puts("first"); }
static void second(void) { puts("second"); }
static void late(void) { puts("late"); }
static void registering(void) { puts("registering"); if (atexit(late)) puts("registration failed"); }
static void nested(void) { exit(-7); puts("after nested"); }
int main(void) {
  if (atexit(first) || atexit(second) || atexit(registering)) return 1;
  nested();
  puts("after main");
  return 99;
}`));
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.exitCode, 249);
  assert.equal(result.rawExitStatus, -7);
  assert.equal(new TextDecoder().decode(result.stdout), 'registering\nlate\nsecond\nfirst\n');
});
