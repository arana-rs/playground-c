#include <limits.h>
#include <stdint.h>
#include <stdbool.h>
#include <float.h>
int main(void) { uint64_t x = UINT64_MAX; bool b = true; return CHAR_BIT == 8 && LONG_MAX == 9223372036854775807L && x == 18446744073709551615ULL && sizeof(int64_t) == 8 && b && !false && FLT_MANT_DIG == 24 && DBL_MANT_DIG == 53; }