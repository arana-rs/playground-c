#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  if (atoi(" -42tail") != -42) return 1;
  if (atol("9223372036854775807") != LONG_MAX) return 2;
  if (atoll("-9223372036854775808") != LLONG_MIN) return 3;

  char *end = 0;
  if (strtol(" -0x2atail", &end, 0) != -42 || strcmp(end, "tail")) return 4;
  if (strtoul("-1x", &end, 10) != ULONG_MAX || strcmp(end, "x")) return 5;
  if (strtoll("077z", &end, 0) != 63 || strcmp(end, "z")) return 6;
  if (strtoull("0xfeed!", &end, 0) != 0xfeedULL || strcmp(end, "!")) return 7;

  const char *unconverted = "  +?";
  end = 0;
  if (strtol(unconverted, &end, 10) != 0 || end != unconverted) return 8;
  errno = 0;
  if (strtol("11", &end, 1) != 0 || end[0] != '1' || errno != EINVAL) return 9;
  errno = 0;
  if (strtol("9223372036854775808!", &end, 10) != LONG_MAX || errno != ERANGE || *end != '!') return 10;
  errno = 0;
  if (strtoull("18446744073709551616!", &end, 10) != ULLONG_MAX || errno != ERANGE || *end != '!') return 11;
  errno = 0;
  if (strtoull("-18446744073709551616!", &end, 10) != ULLONG_MAX || errno != ERANGE || *end != '!') return 17;
  errno = 0;
  if (strtoumax("-18446744073709551616!", &end, 10) != ULLONG_MAX || errno != ERANGE || *end != '!') return 18;

  if (atof("1.5e2x") != 150.0) return 12;
  if (strtod(" -1.25e2tail", &end) != -125.0 || strcmp(end, "tail")) return 13;
  if (strtof("0x1.8p+1!", &end) != 3.0f || strcmp(end, "!")) return 14;
  if (strtof("1.000000059604644775390625", 0) != 1.0f) return 19;
  if (strtof("1.000000059604644775390626", 0) != 1.00000011920928955078125f) return 20;
  if (strtof("0x1.000001p0", 0) != 1.0f || strtof("0x1.0000010000001p0", 0) != 1.00000011920928955078125f) return 21;
  errno = 0;
  if (strtof("0e10", 0) != 0.0f || errno != 0) return 22;
  errno = 0;
  if (!signbit(strtof("-0e-999", 0)) || errno != 0) return 23;
  errno = 0;
  if (strtof("0x0p1000", 0) != 0.0f || errno != 0) return 24;
  errno = 0;
  if (strtold("0e10", 0) != 0.0L || errno != 0) return 25;
  if (strtold("1.0000000000000000001", &end) <= 1.0L || *end != '\0') return 15;
  if (strtod("not a number", &end) != 0.0 || end[0] != 'n') return 16;
  return 0;
}
