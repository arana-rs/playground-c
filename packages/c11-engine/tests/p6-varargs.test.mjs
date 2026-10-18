import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

const project = (source) => ({ entry: 'main.c', files: [{ name: 'main.c', source }] });

const run = (source, expected) => {
  const prepared = prepare(project(source));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expected);
};

const mismatch = (source) => {
  const prepared = prepare(project(source));
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'runtime-error', JSON.stringify(result));
  assert.equal(result.diagnostics[0].code, 'VA_ARG_TYPE_MISMATCH');
  assert.match(result.diagnostics[0].message, /va_arg requested .* but the promoted argument is/);
};

test('va_arg accepts corresponding signed and unsigned types when the value fits both', () => {
  run(`#include <stdarg.h>
    static int read_unsigned(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      unsigned int value = va_arg(arguments, unsigned int);
      va_end(arguments);
      return value == 0u || value == 2147483647u;
    }
    static int read_signed(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      int value = va_arg(arguments, int);
      va_end(arguments);
      return value == 2147483647;
    }
    static int read_unsigned_long(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      unsigned long value = va_arg(arguments, unsigned long);
      va_end(arguments);
      return value == 9223372036854775807UL;
    }
    static int read_signed_long_long(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      long long value = va_arg(arguments, long long);
      va_end(arguments);
      return value == 9223372036854775807LL;
    }
    int main(void) {
      return read_unsigned(0, 0) && read_unsigned(0, 2147483647) &&
        read_signed(0, 2147483647u) &&
        read_unsigned_long(0, 9223372036854775807L) &&
        read_signed_long_long(0, 9223372036854775807ULL);
    }`, 1);
});

test('va_arg accepts void pointer and character pointer types in either direction', () => {
  run(`#include <stdarg.h>
    static int read_void_pointer(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      void *value = va_arg(arguments, void *);
      va_end(arguments);
      return value != 0;
    }
    static int read_character_pointer(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      char *value = va_arg(arguments, char *);
      va_end(arguments);
      return value[0] == 'x';
    }
    static int read_signed_character_pointer(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      signed char *value = va_arg(arguments, signed char *);
      va_end(arguments);
      return value[0] == 7;
    }
    static int read_unsigned_character_pointer(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      unsigned char *value = va_arg(arguments, unsigned char *);
      va_end(arguments);
      return value[0] == 9;
    }
    static int read_const_character_pointer(int marker, ...) {
      va_list arguments;
      va_start(arguments, marker);
      const char *value = va_arg(arguments, const char *);
      va_end(arguments);
      return value[0] == 'q';
    }
    int main(void) {
      char text[] = "x";
      const char const_text[] = "q";
      signed char signed_text[] = { 7 };
      unsigned char unsigned_text[] = { 9 };
      void *opaque_text = text;
      const void *opaque_const_text = const_text;
      void *opaque_signed = signed_text;
      void *opaque_unsigned = unsigned_text;
      return read_void_pointer(0, text) && read_character_pointer(0, opaque_text) &&
        read_signed_character_pointer(0, opaque_signed) &&
        read_unsigned_character_pointer(0, opaque_unsigned) &&
        read_const_character_pointer(0, opaque_const_text);
    }`, 1);
});

test('va_arg retains mismatch diagnostics for values or types outside the exceptions', () => {
  mismatch(`#include <stdarg.h>
    static unsigned int read_value(int marker, ...) {
      va_list arguments; va_start(arguments, marker);
      unsigned int value = va_arg(arguments, unsigned int);
      va_end(arguments); return value;
    }
    int main(void) { return (int)read_value(0, -1); }`);

  mismatch(`#include <stdarg.h>
    static int read_value(int marker, ...) {
      va_list arguments; va_start(arguments, marker);
      int value = va_arg(arguments, int);
      va_end(arguments); return value;
    }
    int main(void) { return read_value(0, 2147483648u); }`);

  mismatch(`#include <stdarg.h>
    static unsigned int read_value(int marker, ...) {
      va_list arguments; va_start(arguments, marker);
      unsigned int value = va_arg(arguments, unsigned int);
      va_end(arguments); return value;
    }
    int main(void) { return (int)read_value(0, 7L); }`);

  mismatch(`#include <stdarg.h>
    static unsigned int *read_value(int marker, ...) {
      va_list arguments; va_start(arguments, marker);
      unsigned int *value = va_arg(arguments, unsigned int *);
      va_end(arguments); return value;
    }
    int main(void) { long value = 1; return read_value(0, &value) != 0; }`);

  mismatch(`#include <stdarg.h>
    static int *read_value(int marker, ...) {
      va_list arguments; va_start(arguments, marker);
      int *value = va_arg(arguments, int *);
      va_end(arguments); return value;
    }
    int main(void) { int value = 1; void *opaque = &value; return read_value(0, opaque) != 0; }`);
});
