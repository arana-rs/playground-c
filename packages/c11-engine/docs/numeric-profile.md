# Numeric profile

The target choices follow the [x86-64 psABI](https://gitlab.com/x86-psABIs/x86-64-ABI/blob/master/x86-64-ABI/low-level-sys-info.tex) and [GCC x86 options](https://gcc.gnu.org/onlinedocs/gcc/x86-Options.html). Bit-field allocation and signedness are fixed to this SysV x86-64 profile, not universal C guarantees.

| Type | Size | Representation |
| --- | ---: | --- |
| `_Bool`, `char`, `signed char`, `unsigned char` | 1 byte | 8-bit signed `char` |
| `short`, `unsigned short` | 2 bytes | 16-bit integer |
| `int`, `unsigned int` | 4 bytes | 32-bit integer |
| `long`, `unsigned long`, `long long`, `unsigned long long` | 8 bytes | 64-bit integer, stored as `BigInt` |
| Object or function pointer | 8 bytes | 64-bit virtual address |
| `float`, `double` | 4 / 8 bytes | IEEE binary32 / binary64 |
| `long double` | 16 bytes | x87 binary80 value (64-bit significand and 15-bit exponent), with 16-byte storage and alignment |

The profile uses little-endian byte order, 8-bit bytes, two's complement, signed `char`, and `FLT_EVAL_METHOD == 0`. Unsigned integers wrap modulo 2^N; out-of-range conversions to signed integers use the low bits, and signed right shift is arithmetic. `long double` preserves binary80 in arithmetic, memory, variadic arguments, and `%L` conversions. The real-valued `math.h` function set uses a software binary80 kernel; the profile does not promise correct rounding for every input, Annex F conformance, or bit-for-bit equality across JavaScript engines. `fma`, `fmaf`, and `fmal` preserve the exact ternary result until rounding once to the result type. Some cases of undefined behavior are detected, including signed overflow, integer division by zero, invalid shifts, uninitialized reads, and accesses outside virtual objects. The engine does not claim to detect all undefined behavior.
