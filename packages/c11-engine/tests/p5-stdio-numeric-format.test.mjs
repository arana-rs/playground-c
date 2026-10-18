import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '../dist/core/index.js';

function run(source) {
  const prepared = prepare({ entry: 'stdio-numeric-format.c', files: [{ name: 'stdio-numeric-format.c', source }] });
  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  const result = execute(prepared.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0, `C program returned ${result.mainReturn}`);
  return result;
}

test('scanf rounds decimal and hexadecimal subjects directly to float, double, and long double', () => {
  run(`#include <stdio.h>
#include <stdlib.h>

int main(void) {
  float single = 0.0f;
  double precise = 0.0;
  long double extended = 0.0L;
  char next = 0;
  char *end;

  if (sscanf("1.000000059604644775390625!", "%f%c", &single, &next) != 2 || single != 1.0f || next != '!') return 1;
  if (sscanf("1.000000059604644775390626!", "%f%c", &single, &next) != 2 || single != 0x1.000002p0f || next != '!') return 2;
  if (sscanf("0x1.000001p0!", "%f%c", &single, &next) != 2 || single != 1.0f || next != '!') return 3;
  if (sscanf("0x1.0000010000001p0!", "%f%c", &single, &next) != 2 || single != 0x1.000002p0f || next != '!') return 4;
  if (sscanf("-1.000000059604644775390626!", "%f%c", &single, &next) != 2 || single != -0x1.000002p0f || next != '!') return 14;
  if (sscanf("0x1p-150!", "%f%c", &single, &next) != 2 || single != 0.0f || next != '!') return 5;
  if (sscanf("0x1.8p-150!", "%f%c", &single, &next) != 2 || single != 0x1p-149f || next != '!') return 6;

  if (sscanf("0x1.00000000000008p0!", "%lf%c", &precise, &next) != 2 || precise != 1.0 || next != '!') return 7;
  if (sscanf("0x1.0000000000000801p0!", "%lf%c", &precise, &next) != 2 || precise != 0x1.0000000000001p0 || next != '!') return 8;
  if (sscanf("0x1p-1075!", "%lf%c", &precise, &next) != 2 || precise != 0.0 || next != '!') return 9;
  if (sscanf("0x1.0000000000000001p-1075!", "%lf%c", &precise, &next) != 2 || precise != 0x0.0000000000001p-1022 || next != '!') return 10;

  if (sscanf("0x1p-16446!", "%Lf%c", &extended, &next) != 2 || extended != 0.0L || next != '!') return 11;
  if (sscanf("0x1.0000000000000001p-16446!", "%Lf%c", &extended, &next) != 2 || extended != 0x1p-16445L || next != '!') return 12;
  if (strtof("1.000000059604644775390626!", &end) != 0x1.000002p0f || *end != '!') return 13;
  return 0;
}
`);
});

test('printf supports decimal precision above 100 with exact rounding and snprintf counts', () => {
  run(`#include <stdio.h>
#include <string.h>

int main(void) {
  char output[512];
  char short_output[8];
  int count = snprintf(output, sizeof output, "%.101f", 0.5);
  if (count != 103 || strlen(output) != 103 || output[0] != '0' || output[1] != '.' || output[2] != '5') return 1;
  for (int index = 3; index < count; index++) if (output[index] != '0') return 2;

  count = snprintf(output, sizeof output, "%.101e", 1.25);
  if (count != 107 || output[0] != '1' || output[1] != '.' || output[2] != '2' || output[3] != '5' || output[103] != 'e' || output[104] != '+' || output[105] != '0' || output[106] != '0') return 3;
  count = snprintf(output, sizeof output, "%+.101E", 1.0);
  if (count != 108 || output[0] != '+' || output[1] != '1' || output[104] != 'E' || output[105] != '+' || output[106] != '0' || output[107] != '0') return 4;

  count = snprintf(output, sizeof output, "%#.101g", 1.25);
  if (count != 102 || output[0] != '1' || output[1] != '.' || output[2] != '2' || output[3] != '5' || output[101] != '0') return 5;
  count = snprintf(output, sizeof output, "%.500g", 1.25);
  if (count != 4 || strcmp(output, "1.25") != 0) return 6;
  count = snprintf(output, sizeof output, "%#.500G", 1.25);
  if (count != 501 || output[0] != '1' || output[1] != '.' || output[2] != '2' || output[3] != '5' || output[500] != '0') return 7;
  count = snprintf(output, sizeof output, "%#.101G", 1e300);
  if (count != 107 || output[0] != '1' || output[1] != '.' || output[102] != 'E' || output[103] != '+' || output[104] != '3' || output[105] != '0' || output[106] != '0') return 8;

  count = snprintf(output, sizeof output, "%.1f %.1f %#.0f", 1.25, 1.75, 1.5);
  if (count != 10 || strcmp(output, "1.2 1.8 2.") != 0) return 9;
  float single = 1.25f;
  count = snprintf(output, sizeof output, "%#.3f %.2e %.3g %#.4G", single, single, single, single);
  if (strcmp(output, "1.250 1.25e+00 1.25 1.250") != 0) return 14;
  count = snprintf(output, sizeof output, "%+08.2f", -0.0);
  if (count != 8 || strcmp(output, "-0000.00") != 0) return 15;
  count = snprintf(short_output, sizeof short_output, "%#.500f", 0.5);
  if (count != 502 || strcmp(short_output, "0.50000") != 0 || short_output[7] != '\0') return 10;

  long double extended = 1.0L + 0x1p-63L;
  count = snprintf(output, sizeof output, "%.4LE %#.5Lg", extended, extended);
  if (count != 17 || strcmp(output, "1.0000E+00 1.0000") != 0) return 16;
  count = snprintf(output, sizeof output, "%.500Lf", extended);
  if (count != 502 || output[0] != '1' || output[1] != '.') return 11;
  for (int index = 2; index < 20; index++) if (output[index] != '0') return 12;
  if (output[20] != '1') return 13;
  return 0;
}
`);
});
