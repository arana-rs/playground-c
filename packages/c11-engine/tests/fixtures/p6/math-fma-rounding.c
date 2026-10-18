#include <math.h>
#include <float.h>

#define IS_TYPE(expression, expected_type) _Generic((expression), expected_type: 1, default: 0)

int main(void)
{
    if (!IS_TYPE(fma(1.0, 1.0, 1.0), double)) return 0;
    if (!IS_TYPE(fmaf(1.0f, 1.0f, 1.0f), float)) return 0;
    if (!IS_TYPE(fmal(1.0L, 1.0L, 1.0L), long double)) return 0;

    double double_delta = 0x1p-27;
    float float_delta = 0x1p-13f;
    long double long_double_delta = 0x1p-33L;
    if (fma(1.0 + double_delta, 1.0 - double_delta, -1.0) != -0x1p-54) return 0;
    if (fmaf(1.0f + float_delta, 1.0f - float_delta, -1.0f) != -0x1p-26f) return 0;
    if (fmal(1.0L + long_double_delta, 1.0L - long_double_delta, -1.0L) != -0x1p-66L) return 0;
    if (fma(DBL_MAX, 2.0, -DBL_MAX) != DBL_MAX) return 0;
    if (fmaf(FLT_MAX, 2.0f, -FLT_MAX) != FLT_MAX) return 0;
    if (fmal(LDBL_MAX, 2.0L, -LDBL_MAX) != LDBL_MAX) return 0;

    /* These exact results lie just above a target midpoint. Rounding first
       through binary80 would turn them into ties and select the wrong value. */
    double double_midpoint = 1.0 + 0x1p-52;
    if (fma(double_midpoint, double_midpoint, -0x1.8p-52) != double_midpoint) return 0;

    float float_left = 1.0f + 0x1p-23f;
    float float_right = 1.0f - 0x1p-24f;
    float float_tail = 0x1.000002p-47f;
    if (fmaf(float_left, float_right, float_tail) != 1.0f + 0x1p-23f) return 0;

    /* This binary80 result is exactly above a midpoint. Rounding the product
       before adding the cancellation term produces a different result. */
    long double extended_left = 0x1.7a451e765a457ef2p+0L;
    long double extended_right = 0x1.fa8c2e87d9b925f2p+0L;
    long double extended_tail = -(long double)0x5d8f781877d9274cULL * 0x1p-61L;
    if (fmal(extended_left, extended_right, extended_tail) != 0x9812ef2be7fd9f58ULL * 0x1p-125L) return 0;

    if (!isnan(fmal(INFINITY, 0.0L, 1.0L)) || !isnan(fmal(INFINITY, 2.0L, -INFINITY)) ||
        !isinf(fmal(INFINITY, 2.0L, 1.0L))) return 0;

    return 1;
}
