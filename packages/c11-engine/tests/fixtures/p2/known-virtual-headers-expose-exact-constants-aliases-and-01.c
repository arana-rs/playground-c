#include <limits.h>
#include <stdint.h>
#include <stdbool.h>
#include <float.h>
int main(void) {
  uint64_t x = UINT64_MAX; int64_t y = INT64_MIN; bool b = true;
  return CHAR_BIT == 8 && CHAR_MIN == -128 && SHRT_MAX == 32767 &&
    INT_MAX == 2147483647 && LONG_MAX == 9223372036854775807L &&
    x == 18446744073709551615ULL && y == (-9223372036854775807LL - 1) &&
    sizeof(int8_t) == 1 && sizeof(uint16_t) == 2 && sizeof(int32_t) == 4 && sizeof(uint64_t) == 8 &&
    b == 1 && false == 0 && __bool_true_false_are_defined == 1 &&
    FLT_RADIX == 2 && FLT_MANT_DIG == 24 && DBL_MANT_DIG == 53 && FLT_EVAL_METHOD == 0;
}