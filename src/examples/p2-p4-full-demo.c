/* P2–P4: LP64 scalars, expressions, control flow, objects, the preprocessor, and libc.
 * Run: exit code 42 means success. If a group fails:
 * 1 types/headers, 2 integers, 3 floating point, 4 operators,
 * 5 control flow, 6 functions, 7 double math, 8 float math,
 * 9 arrays/designators/strings, 10 pointers/functions/stddef,
 * 11 aggregates/bytes/enums/anonymous members,
 * 12 globals/compound literals/heap, 13 translation/macros/argv,
 * 14 linkage/inline/K&R/varargs, 15 stdio/formatting/virtual files,
 * 16 string/ctype/errno/inttypes/assert.
 * Each passing P4 group prints one line to the console.
 */
#include <assert.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <float.h>
#include <inttypes.h>
#include <iso646.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define P4_ANSWER 42
#define P4_PASTE_RAW(left, right) left##right
#define P4_PASTE(left, right) P4_PASTE_RAW(left, right)
#define P4_STRING_RAW(value) #value
#define P4_STRING(value) P4_STRING_RAW(value)
#define P4_PRINT(...) printf(__VA_ARGS__)
#define P4_TEMPORARY 1
#undef P4_TEMPORARY
#if defined(P4_ANSWER) && P4_ANSWER == 42
#define P4_CONDITIONAL_OK 1
#else
#error P4 macro condition failed
#endif
#ifndef P4_TEMPORARY
#define P4_UNDEF_OK 1
#endif
#pragma STDC FP_CONTRACT OFF

struct Pair { int left; int right; };
union Number { unsigned int value; unsigned char bytes[4]; };

int visits = 8;
static int totals[2];
int *static_values = (int[]) { 40, 2 };

int types(void);
int integers(void);
int floating_point(void);
int operators(void);
int control_flow(void);
int functions(void);
int math_double(void);
int math_float(void);
int arrays_designators(void);
int pointers(void);
int aggregates(void);
int globals_and_heap(void);
int preprocessor_and_arguments(int argc, char **argv);
int functions_p4(void);
int stdio_p4(void);
int library_p4(void);
long factorial(int n);
bool even(int n);
bool odd(int n);
unsigned char next_value(unsigned char value);
float round_value(double value);
int sum_copy(int value);
void pause(void);
int sum_array(int values[], int count);
int increment(int value);
int apply(int (*operation)(int), int value);
struct Pair adjust_pair(struct Pair value);
int visit_global(void);

int main(int argc, char **argv) {
    if (!types()) return 1;
    if (!integers()) return 2;
    if (!floating_point()) return 3;
    if (!operators()) return 4;
    if (!control_flow()) return 5;
    if (!functions()) return 6;
    if (!math_double()) return 7;
    if (!math_float()) return 8;
    if (!arrays_designators()) return 9;
    if (!pointers()) return 10;
    if (!aggregates()) return 11;
    if (!globals_and_heap()) return 12;
    if (!preprocessor_and_arguments(argc, argv)) return 13;
    P4_PRINT("P4 macros, conditional, #undef, and argv: ok\n");
    if (!functions_p4()) return 14;
    P4_PRINT("P4 static inline, K&R, and va_copy: ok\n");
    if (!stdio_p4()) return 15;
    P4_PRINT("P4 printf/snprintf and virtual binary files: ok\n");
    if (!library_p4()) return 16;
    P4_PRINT("P4 string, ctype, errno, inttypes, and assert: ok\n");
    return 42;
}

static inline int sum_p4(int left, int right) {
    return left + right;
}

static int old_style_p4(value)
int value;
{
    return value + 1;
}

static int collect_p4(int count, ...) {
    va_list original;
    va_list copy;
    va_start(original, count);
    va_copy(copy, original);

    int first = va_arg(original, int);
    double promoted = va_arg(original, double);
    int third = va_arg(original, int);
    int copy_first = va_arg(copy, int);
    int copy_second = va_arg(copy, double) == 2.5;

    va_end(copy);
    va_end(original);
    return count == 3 && first == 9 && promoted == 2.5
        && third == 33 && copy_first == 9 && copy_second;
}

int preprocessor_and_arguments(int argc, char **argv) {
    int P4_PASTE(p4_, answer) = P4_ANSWER;
    const char *text = P4_STRING(P4_ANSWER);
    return argc == 1 && argv != NULL && argv[0] != NULL && argv[1] == NULL
        && argv[0][0] == 'm' && argv[0][1] == 'a' && argv[0][2] == 'i'
        && argv[0][3] == 'n' && argv[0][4] == '.' && argv[0][5] == 'c'
        && argv[0][6] == '\0' && P4_CONDITIONAL_OK && P4_UNDEF_OK
        && p4_answer == 42 && strcmp(text, "42") == 0;
}

int functions_p4(void) {
    short promoted_integer = 9;
    float promoted_real = 2.5f;
    assert(sum_p4(40, 2) == 42);
    return sum_p4(20, 22) == 42
        && old_style_p4(41) == 42
        && collect_p4(3, promoted_integer, promoted_real, 33);
}

int stdio_p4(void) {
    char buffer[32];
    int length = snprintf(buffer, sizeof buffer, "%s:%" PRIu64, "value", UINT64_C(42));
    if (length != 8 || strcmp(buffer, "value:42") != 0) return 0;
    if (printf("P4 output %s\n", buffer) < 0) return 0;

    FILE *file = fopen("p4-example.bin", "w+b");
    if (file == NULL) return 0;
    const unsigned char expected[3] = { 'A', 0, 'B' };
    if (fwrite(expected, 1, 3, file) != 3 || ftell(file) != 3) return 0;
    if (fseek(file, 0, SEEK_SET) != 0) return 0;
    unsigned char current[3] = { 0, 0, 0 };
    if (fread(current, 1, 3, file) != 3) return 0;
    if (fgetc(file) != EOF || !feof(file) || ferror(file)) return 0;
    if (ungetc('Z', file) == EOF || feof(file) || fgetc(file) != 'Z') return 0;
    if (fseek(file, 2, SEEK_SET) != 0 || fgetc(file) != 'B') return 0;
    if (fclose(file) != 0) return 0;
    return current[0] == 'A' && current[1] == 0 && current[2] == 'B';
}

int library_p4(void) {
    int32_t parsed = 0;
    if (sscanf("42", "%" SCNd32, &parsed) != 1 || parsed != 42) return 0;
    if (!isalpha('A') || !isdigit('7') || tolower('Q') != 'q') return 0;

    char text[16] = "abc";
    memmove(text + 1, text, 3);
    if (strcmp(text, "aabc") != 0 || strlen(text) != 4) return 0;
    char words[] = "red,green,blue";
    char *first = strtok(words, ",");
    char *second = strtok(NULL, ",");
    if (first == NULL || second == NULL || strcmp(first, "red") != 0
        || strcmp(second, "green") != 0) return 0;

    errno = 0;
    intmax_t overflow = strtoimax("999999999999999999999999", NULL, 10);
    return overflow == INTMAX_MAX && errno == ERANGE;
}

// All available scalar types and Linux profile constants.
int types(void) {
    _Bool normalized = 9;
    bool active = true;
    char c = '\n';
    signed char sc = -2;
    unsigned char uc = 255;
    short s = -300;
    unsigned short us = 65535;
    int i = 42;
    unsigned int ui = 42U;
    long l = 42L;
    unsigned long ul = 42UL;
    long long ll = 42LL;
    unsigned long long ull = 42ULL;
    float f = 1.25f;
    double d = 0x1.4p0;
    return normalized == 1 && active && !false
        && c == 10 && sc == -2 && uc == UCHAR_MAX
        && s == -300 && us == USHRT_MAX && i == ui
        && l == ul && ll == ull && f == d
        && sizeof(_Bool) == 1 && sizeof(char) == 1
        && sizeof(short) == 2 && sizeof(int) == 4
        && sizeof(long) == 8 && sizeof(long long) == 8
        && sizeof(float) == 4 && sizeof(double) == 8
        && CHAR_BIT == 8 && CHAR_MIN == SCHAR_MIN && CHAR_MAX == SCHAR_MAX
        && INT_MAX == 2147483647 && LONG_MAX == LLONG_MAX
        && FLT_RADIX == 2 && FLT_MANT_DIG == 24 && DBL_MANT_DIG == 53
        && FLT_EVAL_METHOD == 0 && __bool_true_false_are_defined == 1
        && sizeof(int8_t) == 1 && sizeof(uint16_t) == 2
        && sizeof(int32_t) == 4 && sizeof(uint64_t) == 8
        && sizeof(int_least16_t) == 2 && sizeof(int_fast32_t) == 8
        && sizeof(intmax_t) == 8 && sizeof(uintptr_t) == 8;
}

// Exact 64-bit values, unsigned wraparound, promotions, casts, and escapes.
int integers(void) {
    uint64_t exact = 9007199254740993ULL;
    uint64_t wrapped = UINT64_MAX + 1ULL;
    int64_t minimum = INT64_MIN;
    unsigned char small = 255;
    return exact - 9007199254740992ULL == 1ULL && wrapped == 0
        && minimum == LONG_MIN && UINT64_MAX == ULLONG_MAX
        && small + 1 == 256 && sizeof(small + 1) == 4
        && !(-1 < 1U) && (unsigned int)-1 == UINT_MAX
        && (signed char)255 == -1 && (int)3.75 == 3
        && 42 == 052 && 42 == 0x2a && '\101' == '\x41'
        && '\t' == 9 && '\r' == 13 && '\\' == 92 && '\'' == 39;
}

// Binary32/binary64, negative zero, NaN, infinity, and subnormals.
int floating_point(void) {
    float rounded = (float)16777217;
    float tiny = FLT_TRUE_MIN;
    double negative = -0.0;
    double nan = NAN;
    double infinite = INFINITY;
    return rounded == 16777216.0f && .5e1 == 0x1.4p2
        && FLT_EPSILON == 0x1p-23f && DBL_EPSILON == 0x1p-52
        && tiny > 0.0f && fpclassify(tiny) == FP_SUBNORMAL
        && fpclassify(DBL_TRUE_MIN) == FP_SUBNORMAL
        && negative == 0.0 && signbit(negative)
        && fpclassify(negative) == FP_ZERO
        && isnan(nan) && nan != nan && !(nan < 1.0)
        && fpclassify(nan) == FP_NAN
        && isinf(infinite) && !isfinite(infinite)
        && fpclassify(infinite) == FP_INFINITE
        && isfinite(1.0) && isnormal(FLT_MIN) && !isnormal(tiny)
        && fpclassify(1.0) == FP_NORMAL
        && isnan(sqrt(-1.0)) && isinf(HUGE_VAL) && isinf(HUGE_VALF);
}

// Short-circuit and comma sequence side effects; sizeof does not execute ++.
int operators(void) {
    int x = 0;
    int y = 0;
    int z = (x = y = 5);
    if (x != 5 || y != 5 || z != 5) return 0;
    x = 0;
    0 && ++x;
    1 || ++x;
    if (x != 0 || sizeof(++x) != 4 || x != 0) return 0;
    y = 1 ? (x = 2) : ++x;
    z = 0 ? ++x : (x += 3);
    if (x != 5 || y != 2 || z != 5) return 0;
    y = (x = 2, x += 3, x * 4);
    if (x != 5 || y != 20 || sizeof(1 ? 1.0f : 2.0) != 8) return 0;
    int i = 4;
    int a = i++;
    int b = ++i;
    int c = i--;
    int d = --i;
    if (a != 4 || b != 6 || c != 6 || d != 4 || i != 4) return 0;
    int n = 10;
    n += 2; n -= 3; n *= 4; n /= 6; n %= 4;
    n <<= 3; n >>= 2; n |= 3; n ^= 6; n &= 1;
    (void)n;
    return n == 1 && +i == 4 && -i == -4 && !0 && ~0U == UINT_MAX
        && 2 + 3 == 5 && 7 - 2 == 5 && 3 * 4 == 12
        && -7 / 3 == -2 && -7 % 3 == -1
        && (1U << 4) == 16U && (16U >> 2) == 4U && (-8 >> 2) == -2
        && (6 & 3) == 2 && (6 ^ 3) == 5 && (6 | 3) == 7
        && i == 4 && i != 5 && i < 5 && i <= 4 && i > 3 && i >= 4;
}

// Scopes, branches, switch fallthrough, and all three loop forms.
int control_flow(void) {
    int x = 1;
    { int x = 8; ++x; if (x != 9) return 0; }
    if (x == 1) x = 3; else x = 99;
    int selector = 1;
    switch (selector++) {
        case 0: x = 99; break;
        case 1: x += 2; /* fallthrough */
        case 2: x += 3; break;
        default: x = 99;
    }
    if (x != 8 || selector != 2) return 0;
    switch (99) { case 1: return 0; default: x = 4; }
    int i = 99;
    int sum = 0;
    for (int i = 0; i < 6; ++i) {
        if (i == 2) continue;
        if (i == 5) break;
        sum += i;
    }
    if (i != 99 || sum != 8) return 0;
    i = 0; sum = 0;
    while (i < 6) {
        ++i;
        if (i == 2) continue;
        if (i == 5) break;
        sum += i;
    }
    if (sum != 8) return 0;
    i = 0; sum = 0;
    do { ++i; if (i == 2) continue; sum += i; } while (i < 3);
    if (sum != 4 || x != 4) return 0;
    // Goto forward, backward, and out of a block.
    int steps = 0;
    goto repeat;
    steps = 99;
repeat: ;
    ++steps;
    if (steps < 3) goto repeat;
    { int extra = 4; steps += extra; goto done; }
done:
    return steps == 7;
}

// Prototypes, pass-by-value, return conversion, and recursive frames.
int functions(void) {
    int original = 2;
    int copy = sum_copy(original);
    int argument = 511;
    pause();
    // The parameter converts 511 to 255; the return converts 256 to 0.
    return original == 2 && copy == 9 && next_value(argument) == 0
        && round_value(16777217.0) == 16777216.0f
        && factorial(20) == 2432902008176640000L && even(24) && odd(23);
}
int sum_copy(int value) { value += 7; return value; }
unsigned char next_value(unsigned char value) { return value + 1; }
float round_value(double value) { return value; }
void pause(void) { return; }
long factorial(int n) {
    if (n <= 1) return 1L;
    long stored = n;
    return stored * factorial(n - 1);
}
bool even(int n) { if (n == 0) return true; return odd(n - 1); }
bool odd(int n) { if (n == 0) return false; return even(n - 1); }

// The 34 double functions: arguments with simple exact results.
int math_double(void) {
    return sqrt(81.0) == 9.0 && fabs(-2.5) == 2.5
        && sin(0.0) == 0.0 && cos(0.0) == 1.0 && tan(0.0) == 0.0
        && asin(0.0) == 0.0 && acos(1.0) == 0.0 && atan(0.0) == 0.0
        && sinh(0.0) == 0.0 && cosh(0.0) == 1.0 && tanh(0.0) == 0.0
        && asinh(0.0) == 0.0 && acosh(1.0) == 0.0 && atanh(0.0) == 0.0
        && exp(0.0) == 1.0 && exp2(3.0) == 8.0 && expm1(0.0) == 0.0
        && log(1.0) == 0.0 && log2(8.0) == 3.0 && log10(1.0) == 0.0
        && log1p(0.0) == 0.0 && floor(-2.5) == -3.0 && ceil(-2.5) == -2.0
        && trunc(-2.5) == -2.0 && round(-2.5) == -3.0 && cbrt(8.0) == 2.0
        && fmod(-7.0, 3.0) == -1.0 && pow(2.0, 10.0) == 1024.0
        && atan2(0.0, 1.0) == 0.0 && hypot(3.0, 4.0) == 5.0
        && fmin(2.0, 3.0) == 2.0 && fmax(2.0, 3.0) == 3.0
        && fdim(3.0, 2.0) == 1.0 && copysign(2.0, -1.0) == -2.0;
}

// The same 34 functions with float precision and the f suffix.
int math_float(void) {
    return sqrtf(81.0f) == 9.0f && fabsf(-2.5f) == 2.5f
        && sinf(0.0f) == 0.0f && cosf(0.0f) == 1.0f && tanf(0.0f) == 0.0f
        && asinf(0.0f) == 0.0f && acosf(1.0f) == 0.0f && atanf(0.0f) == 0.0f
        && sinhf(0.0f) == 0.0f && coshf(0.0f) == 1.0f && tanhf(0.0f) == 0.0f
        && asinhf(0.0f) == 0.0f && acoshf(1.0f) == 0.0f && atanhf(0.0f) == 0.0f
        && expf(0.0f) == 1.0f && exp2f(3.0f) == 8.0f && expm1f(0.0f) == 0.0f
        && logf(1.0f) == 0.0f && log2f(8.0f) == 3.0f && log10f(1.0f) == 0.0f
        && log1pf(0.0f) == 0.0f && floorf(-2.5f) == -3.0f && ceilf(-2.5f) == -2.0f
        && truncf(-2.5f) == -2.0f && roundf(-2.5f) == -3.0f && cbrtf(8.0f) == 2.0f
        && fmodf(-7.0f, 3.0f) == -1.0f && powf(2.0f, 10.0f) == 1024.0f
        && atan2f(0.0f, 1.0f) == 0.0f && hypotf(3.0f, 4.0f) == 5.0f
        && fminf(2.0f, 3.0f) == 2.0f && fmaxf(2.0f, 3.0f) == 3.0f
        && fdimf(3.0f, 2.0f) == 1.0f && copysignf(2.0f, -1.0f) == -2.0f;
}

// Multidimensional arrays, decay, designators, brace elision, and NUL.
int arrays_designators(void) {
    int matrix[2][3] = { [1][2] = 9, [0] = { 3, 4 } };
    int flat[2][2] = { 1, 2, 3, 4 };
    char text[] = "C11";
    char *literal = "C11";
    text[1] = '8';
    return sizeof(matrix) == 24 && sizeof(matrix[0]) == 12
        && matrix[0][0] == 3 && matrix[0][1] == 4 && matrix[0][2] == 0
        && matrix[1][0] == 0 && matrix[1][2] == 9
        && flat[1][0] == 3 && flat[1][1] == 4
        && sum_array(matrix[1], 3) == 9
        && sizeof(text) == 4 && text[1] == '8' && text[3] == '\0'
        && sizeof("C11") == 4 && literal[3] == '\0';
}
int sum_array(int values[], int count) {
    int total = 0;
    for (int index = 0; index < count; ++index) total += values[index];
    return sizeof(values) == sizeof(int *) ? total : -1;
}

// void * conversion, one-past pointers, arithmetic, indirect calls, and stddef.
int pointers(void) {
    int values[3] = { 10, 20, 12 };
    int *begin = values;
    int *end = begin + 3;
    void *opaque = begin + 1;
    int *alias = (int *)opaque;
    int *null_pointer = NULL;
    size_t byte_count = sizeof(values);
    ptrdiff_t element_count = end - begin;
    int (*operation)(int) = increment;
    *alias += 1;
    return values[1] == 21 && alias == begin + 1 && *alias == 21
        && element_count == 3 && byte_count == 12 && end == &values[3]
        && apply(operation, 41) == 42 && null_pointer == 0;
}
int increment(int value) { return value + 1; }
int apply(int (*operation)(int), int value) { return operation(value); }

// Aggregate copies, anonymous members, enums, ->, and a little-endian view.
int aggregates(void) {
    enum State { START, READY = 4, FINISHED };
    struct Record {
        int label;
        struct { int left; int right; };
        union { int code; unsigned int bits; };
    };
    struct Record record = {
        .right = 22, .label = 1, .left = 20, .code = 42
    };
    enum State state = FINISHED;
    struct Pair original = { .right = 22, .left = 20 };
    struct Pair copy = original;
    struct Pair changed = adjust_pair(copy);
    struct Pair *view = &(struct Pair) { .right = 4, .left = 3 };
    union Number number = { .value = 0x12345678U };
    unsigned char *bytes = (unsigned char *)&number;
    view->left += view->right;
    return record.label == 1 && record.left == 20
        && record.right == 22 && record.code == 42
        && state == 5 && READY == 4 && START == 0
        && sizeof(original) == 8 && sizeof(number) == 4
        && original.left == 20 && copy.left == 20
        && changed.left == 21 && changed.right == 22
        && view->left == 7 && view->right == 4
        && number.value == 0x12345678U
        && bytes[0] == 0x78 && bytes[1] == 0x56
        && bytes[2] == 0x34 && bytes[3] == 0x12;
}
struct Pair adjust_pair(struct Pair value) {
    ++value.left;
    return value;
}

// Reinitializable globals, automatic/static compound literals, and basic heap use.
int globals_and_heap(void) {
    int *temporary = &(int) { 40 };
    int *heap = malloc(2 * sizeof(int));
    if (heap == NULL) return 0;
    heap[0] = 17;
    heap[1] = 25;
    int after = visit_global();
    int static_sum = static_values[0] + static_values[1];
    int heap_sum = heap[0] + heap[1];
    free(heap);
    free(NULL);
    return after == 9 && visits == 9 && totals[0] == 0 && totals[1] == 1
        && static_sum == 42 && *temporary == 40 && heap_sum == 42;
}
int visit_global(void) {
    ++visits;
    ++totals[1];
    return visits;
}

/* To explore diagnostics, temporarily change a return in main:
 * return INT_MAX + 1;       // Signed overflow.
 * return 7 / 0;             // Integer division by zero.
 * return 1 << 32;           // Invalid shift.
 * int x; return x;          // Uninitialized local.
 * return (int)1e100;        // Conversion out of range.
 * int x = 0; return x++ + x;// Unsequenced accesses.
 * while (1) {}              // The limit stops it; Stop cancels it.
 * Removing main's return exits with 0; falling off a non-void function fails.
 */
