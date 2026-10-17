import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const source = `#include <stdarg.h>
#include <string.h>

static long double read_extra(int marker, ...) {
  va_list arguments;
  va_start(arguments, marker);
  long double value = va_arg(arguments, long double);
  va_end(arguments);
  return value;
}

int main(void) {
  struct Aligned { char prefix; long double value; };
  union Representation { long double value; unsigned char bytes[16]; };
  long double precise = 1.0L + 0x1p-63L;
  long double negative_zero = -0.0L;
  float rounded = (float)(1.0L + 0x1p-24L + 0x1p-63L);
  unsigned long maximum = (unsigned long)18446744073709551615.0L;
  union Representation representation;
  long double copied;

  if (sizeof(long double) != 16 || sizeof(struct Aligned) != 32) return 1;
  if (precise == 1.0L || !(precise > 1.0L)) return 2;
  if (rounded != 0x1.000002p0f) return 3;
  if (maximum != 18446744073709551615UL) return 4;
  if (negative_zero != 0.0L || negative_zero) return 5;
  if (read_extra(0, precise) != precise) return 6;

  representation.value = 1.0L;
  if (representation.bytes[7] != 128 || representation.bytes[8] != 255 || representation.bytes[9] != 63) return 7;
  memcpy(&copied, &representation.value, sizeof copied);
  if (copied != 1.0L) return 8;
  return 0;
}`;

test('C runtime uses binary80 storage, arithmetic, direct casts, varargs, and object representation', () => {
  const prepared = prepare({ entry: 'binary80.c', files: [{ name: 'binary80.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
});
