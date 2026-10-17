#include <stdarg.h>
#include <stdio.h>
#include <string.h>

static int vformat(char *destination, size_t capacity, const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vsnprintf(destination, capacity, format, arguments);
  va_end(arguments);
  return count;
}

static int vformat_twice(char *left, char *right, size_t capacity, const char *format, ...) {
  va_list original, first, second;
  va_start(original, format);
  va_copy(first, original);
  va_copy(second, original);
  int left_count = vsnprintf(left, capacity, format, first);
  int right_count = vsnprintf(right, capacity, format, second);
  va_end(first);
  va_end(second);
  va_end(original);
  return left_count == right_count;
}

static int vsprintf_text(char *destination, const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vsprintf(destination, format, arguments);
  va_end(arguments);
  return count;
}

static int vprint_stdout(const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vprintf(format, arguments);
  va_end(arguments);
  return count;
}

static int vprint_stderr(const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vfprintf(stderr, format, arguments);
  va_end(arguments);
  return count;
}

static int vscan_stdin(const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vscanf(format, arguments);
  va_end(arguments);
  return count;
}

static int vscan_stream(FILE *stream, const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vfscanf(stream, format, arguments);
  va_end(arguments);
  return count;
}

static int vscan_string(const char *source, const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vsscanf(source, format, arguments);
  va_end(arguments);
  return count;
}

int main(void) {
  char narrow[32], repeated_a[32], repeated_b[32], unbounded[32];
  if (vformat(narrow, sizeof narrow, "%s:%d", "item", 41) != 7 || strcmp(narrow, "item:41")) return 1;
  if (!vformat_twice(repeated_a, repeated_b, sizeof repeated_a, "%d/%u", -7, 9U)) return 2;
  if (strcmp(repeated_a, "-7/9") || strcmp(repeated_a, repeated_b)) return 3;
  if (vsprintf_text(unbounded, "value=%d", 12) != 8 || strcmp(unbounded, "value=12")) return 4;
  if (vprint_stdout("v=%d\n", 27) != 5) return 5;
  if (vprint_stderr("e=%s", "ok") != 4) return 6;

  int first = 0, second = 0, third = 0;
  if (vscan_stdin("%d", &first) != 1 || first != 31) return 7;
  if (vscan_stream(stdin, "%d", &second) != 1 || second != 32) return 8;
  if (vscan_string("33 tail", "%d", &third) != 1 || third != 33) return 9;
  return 0;
}
