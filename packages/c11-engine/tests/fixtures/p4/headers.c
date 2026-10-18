#include <float.h>
#include <iso646.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>

int main(void) {
    bool enabled = 9;
    int64_t signed_value = INT64_C(9223372036854775807);
    uint64_t unsigned_value = UINT64_C(18446744073709551615);
    int bits = 6;
    bits and_eq 3;
    bits xor_eq 3;
    bits or_eq 4;
    return MB_LEN_MAX >= 1 && CHAR_BIT == 8 && CHAR_MIN == SCHAR_MIN && CHAR_MAX == SCHAR_MAX &&
        SCHAR_MIN == -128 && SCHAR_MAX == 127 && UCHAR_MAX == 255 &&
        SHRT_MIN == -32768 && SHRT_MAX == 32767 && USHRT_MAX == 65535 &&
        INT_MIN == (-2147483647 - 1) && INT_MAX == 2147483647 && UINT_MAX == 4294967295U &&
        LONG_MIN == (-9223372036854775807L - 1L) && LONG_MAX == INT64_C(9223372036854775807) &&
        ULONG_MAX == UINT64_MAX && LLONG_MIN == (-9223372036854775807LL - 1LL) &&
        LLONG_MAX == INT64_MAX && ULLONG_MAX == UINT64_MAX &&
        INT8_MIN == -128 && INT8_MAX == 127 && UINT8_MAX == 255 &&
        INT16_MIN == -32768 && INT16_MAX == 32767 && UINT16_MAX == 65535 &&
        INT32_MIN == (-2147483647 - 1) && INT32_MAX == 2147483647 && UINT32_MAX == 4294967295U &&
        INT64_MIN == LONG_MIN && INT64_MAX == LONG_MAX && UINT64_MAX == ULONG_MAX &&
        INTMAX_MIN == INT64_MIN && INTMAX_MAX == INT64_MAX && UINTMAX_MAX == UINT64_MAX &&
        INTPTR_MIN == INT64_MIN && INTPTR_MAX == INT64_MAX && UINTPTR_MAX == UINT64_MAX &&
        SIZE_MAX == UINT64_MAX && sizeof(signed_value) == 8 && signed_value > 0 &&
        unsigned_value == UINT64_MAX &&
        enabled == true && false == 0 && __bool_true_false_are_defined == 1 &&
        FLT_RADIX == 2 && FLT_MANT_DIG == 24 && DBL_MANT_DIG == 53 &&
        FLT_EVAL_METHOD == 0 &&
        ((enabled and not false) or false) &&
        (1 not_eq 2) && (7 bitand 3) == 3 && (4 bitor 1) == 5 &&
        (1 xor 3) == 2 && (compl 0) == -1 && bits == 5;
}
