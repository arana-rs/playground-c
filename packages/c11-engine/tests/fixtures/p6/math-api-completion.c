#include <errno.h>
#include <float.h>
#include <math.h>

#if !defined(isnan) || !defined(isinf) || !defined(isfinite) || !defined(isnormal) || !defined(signbit) || !defined(fpclassify)
#error "classification macros must be provided by math.h"
#endif

static const float positive_infinity = INFINITY;
static const double huge_double = HUGE_VAL;
static const float huge_float = HUGE_VALF;
static const long double huge_long_double = HUGE_VALL;
static const float quiet_nan = NAN;

static double comparison_value(int *calls, double value)
{
    ++*calls;
    return value;
}

#define CHECK_COMPARE_EVALUATES_ONCE(operation, left_value, right_value, expected) \
    do { \
        int left_count = 0; \
        int right_count = 0; \
        int result = operation(comparison_value(&left_count, (left_value)), comparison_value(&right_count, (right_value))); \
        if (result != (expected) || left_count != 1 || right_count != 1) return 0; \
    } while (0)

int main(void)
{
    int exponent = 0;
    double integral = 0.0;
    float float_integral = 0.0f;
    int quotient = 0;
    int left_calls = 0;
    int right_calls = 0;
    float next_float;
    double next_double;
    long double long_integral = 0.0L;
    long double extended = 1.0L + 0x1p-63L;
    double predecessor_double;
    float successor_float;
    long double successor_long_double;

    if (!_Generic(positive_infinity, float: 1, default: 0) ||
        !_Generic(huge_double, double: 1, default: 0) ||
        !_Generic(huge_float, float: 1, default: 0) ||
        !_Generic(huge_long_double, long double: 1, default: 0) ||
        !_Generic(quiet_nan, float: 1, default: 0) ||
        !_Generic((float_t)0, float: 1, default: 0) ||
        !_Generic((double_t)0, double: 1, default: 0) ||
        !_Generic(frexp(1.0, &exponent), double: 1, default: 0) ||
        !_Generic(modff(1.0f, &float_integral), float: 1, default: 0) ||
        !_Generic(remquol(1.0L, 2.0L, &quotient), long double: 1, default: 0) ||
        !_Generic(nexttowardf(1.0f, 1.0L), float: 1, default: 0) ||
        !_Generic(ilogbf(1.0f), int: 1, default: 0) ||
        !_Generic(lrintl(1.0L), long: 1, default: 0) ||
        !_Generic(llroundf(1.0f), long long: 1, default: 0)) return 0;
    if (MATH_ERRNO != 1 || MATH_ERREXCEPT != 2 ||
        (math_errhandling != MATH_ERRNO && math_errhandling != MATH_ERREXCEPT &&
         math_errhandling != (MATH_ERRNO | MATH_ERREXCEPT))) return 0;
    if (FP_ILOGB0 != ilogb(0.0) || FP_ILOGBNAN != ilogb(NAN)) return 0;
    if (!isinf(positive_infinity) || !isinf(huge_double) || !isinf(huge_float) ||
        !isinf(huge_long_double) || !isnan(quiet_nan) || !isnan(nan("payload"))) return 0;
    if (fpclassify(0.0) != FP_ZERO || fpclassify(positive_infinity) != FP_INFINITE ||
        !signbit(-0.0) || !isnormal(1.0L) || !isfinite(1.0f)) return 0;

    if (frexp(8.0, &exponent) != 0.5 || exponent != 4) return 0;
    if (frexpf(8.0f, &exponent) != 0.5f || exponent != 4) return 0;
    if (frexpl(8.0L, &exponent) != 0.5L || exponent != 4) return 0;
    if (modf(-3.25, &integral) != -0.25 || integral != -3.0) return 0;
    if (modff(-3.25f, &float_integral) != -0.25f || float_integral != -3.0f) return 0;
    if (modfl(-3.25L, &long_integral) != -0.25L || long_integral != -3.0L) return 0;
    if (remquo(17.0, 3.0, &quotient) != -1.0 || quotient % 8 != 6) return 0;
    if (remquof(17.0f, 3.0f, &quotient) != -1.0f || quotient % 8 != 6) return 0;
    if (remquol(17.0L, 3.0L, &quotient) != -1.0L || quotient % 8 != 6) return 0;
    if (remainder(17.0, 3.0) != -1.0 || logb(8.0) != 3.0 || logbf(8.0f) != 3.0f ||
        logbl(8.0L) != 3.0L || ilogb(8.0) != 3) return 0;
    if (ilogbf(8.0f) != 3 || ilogbl(8.0L) != 3 || remainderf(17.0f, 3.0f) != -1.0f || remainderl(17.0L, 3.0L) != -1.0L) return 0;
    if (ldexp(0.75, 4) != 12.0 || ldexpf(0.75f, 4) != 12.0f || ldexpl(0.75L, 4) != 12.0L ||
        scalbn(0.75, 4) != 12.0 || scalbnf(0.75f, 4) != 12.0f || scalbnl(0.75L, 4) != 12.0L ||
        scalbln(0.75, 4L) != 12.0 || scalblnf(0.75f, 4L) != 12.0f || scalblnl(0.75L, 4L) != 12.0L) return 0;
    if (nearbyint(2.5) != 2.0 || nearbyintf(2.5f) != 2.0f || nearbyintl(2.5L) != 2.0L ||
        rint(-2.5) != -2.0 || rintf(-2.5f) != -2.0f || rintl(-2.5L) != -2.0L) return 0;
    if (lround(-2.5) != -3L || lroundf(-2.5f) != -3L || lroundl(-2.5L) != -3L ||
        llrint(2.5) != 2LL || llrintf(2.5f) != 2LL || llrintl(2.5L) != 2LL ||
        llround(-2.5) != -3LL || llroundf(-2.5f) != -3LL || llroundl(-2.5L) != -3LL ||
        lrint(2.5) != 2L || lrintf(2.5f) != 2L || lrintl(2.5L) != 2L) return 0;
    if (erf(0.0) != 0.0 || erff(0.0f) != 0.0f || erfl(0.0L) != 0.0L ||
        erfc(0.0) != 1.0 || erfcf(0.0f) != 1.0f || erfcl(0.0L) != 1.0L ||
        tgamma(1.0) != 1.0 || tgammaf(1.0f) != 1.0f || tgammal(1.0L) != 1.0L ||
        lgamma(1.0) != 0.0 || lgammaf(1.0f) != 0.0f || lgammal(1.0L) != 0.0L) return 0;
    if (!isnan(nanf("float")) || !isnan(nanl("long double"))) return 0;

    next_float = nexttowardf(1.0f, extended);
    next_double = nexttoward(1.0, extended);
    predecessor_double = nextafter(DBL_MAX, 0.0);
    successor_float = nextafterf(FLT_MAX, INFINITY);
    successor_long_double = nextafterl(LDBL_MAX, INFINITY);
    if (next_float != nextafterf(1.0f, 2.0f) ||
        nexttowardl(1.0L, extended) <= 1.0L ||
        next_double != nextafter(1.0, 2.0) ||
        nextafterl(1.0L, 2.0L) <= 1.0L ||
        nextafter(0.0, 1.0) != DBL_TRUE_MIN || nextafterf(0.0f, 1.0f) != FLT_TRUE_MIN ||
        nextafterl(0.0L, 1.0L) != LDBL_TRUE_MIN || !(predecessor_double < DBL_MAX) ||
        !isinf(successor_float) || !isinf(successor_long_double)) return 0;
    if (!isgreater(extended, 1.0) || !isgreaterequal(extended, 1.0) ||
        !isless(1.0, extended) || !islessequal(1.0, extended) ||
        !islessgreater(extended, 1.0) || !isunordered(NAN, 1.0)) return 0;
    if (!isgreater(comparison_value(&left_calls, 2.0), comparison_value(&right_calls, 1.0)) ||
        left_calls != 1 || right_calls != 1) return 0;
    CHECK_COMPARE_EVALUATES_ONCE(isgreater, 2.0, 1.0, 1);
    CHECK_COMPARE_EVALUATES_ONCE(isgreaterequal, 2.0, 2.0, 1);
    CHECK_COMPARE_EVALUATES_ONCE(isless, 1.0, 2.0, 1);
    CHECK_COMPARE_EVALUATES_ONCE(islessequal, 1.0, 1.0, 1);
    CHECK_COMPARE_EVALUATES_ONCE(islessgreater, 1.0, 2.0, 1);
    CHECK_COMPARE_EVALUATES_ONCE(isunordered, NAN, 1.0, 1);
    return 1;
}
