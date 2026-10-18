#include <math.h>
#include <float.h>

#define IS_LONG_DOUBLE(expression) _Generic((expression), long double: 1, default: 0)

int main(void)
{
    if (!IS_LONG_DOUBLE(sqrtl(4.0L)) || !IS_LONG_DOUBLE(fabsl(-1.0L)) ||
        !IS_LONG_DOUBLE(sinl(0.0L)) || !IS_LONG_DOUBLE(cosl(0.0L)) ||
        !IS_LONG_DOUBLE(tanl(0.0L)) || !IS_LONG_DOUBLE(asinl(0.0L)) ||
        !IS_LONG_DOUBLE(acosl(1.0L)) || !IS_LONG_DOUBLE(atanl(0.0L)) ||
        !IS_LONG_DOUBLE(sinhl(0.0L)) || !IS_LONG_DOUBLE(coshl(0.0L)) ||
        !IS_LONG_DOUBLE(tanhl(0.0L)) || !IS_LONG_DOUBLE(asinhl(0.0L)) ||
        !IS_LONG_DOUBLE(acoshl(1.0L)) || !IS_LONG_DOUBLE(atanhl(0.0L)) ||
        !IS_LONG_DOUBLE(expl(0.0L)) || !IS_LONG_DOUBLE(exp2l(0.0L)) ||
        !IS_LONG_DOUBLE(expm1l(0.0L)) || !IS_LONG_DOUBLE(logl(1.0L)) ||
        !IS_LONG_DOUBLE(log2l(8.0L)) || !IS_LONG_DOUBLE(log10l(100.0L)) ||
        !IS_LONG_DOUBLE(log1pl(0.0L)) || !IS_LONG_DOUBLE(floorl(1.5L)) ||
        !IS_LONG_DOUBLE(ceill(1.5L)) || !IS_LONG_DOUBLE(truncl(-1.5L)) ||
        !IS_LONG_DOUBLE(roundl(0.5L)) || !IS_LONG_DOUBLE(cbrtl(8.0L)) ||
        !IS_LONG_DOUBLE(fmodl(5.5L, 2.0L)) || !IS_LONG_DOUBLE(powl(2.0L, 3.0L)) ||
        !IS_LONG_DOUBLE(atan2l(0.0L, 1.0L)) || !IS_LONG_DOUBLE(hypotl(3.0L, 4.0L)) ||
        !IS_LONG_DOUBLE(fminl(2.0L, 3.0L)) || !IS_LONG_DOUBLE(fmaxl(2.0L, 3.0L)) ||
        !IS_LONG_DOUBLE(fdiml(3.0L, 2.0L)) || !IS_LONG_DOUBLE(copysignl(2.0L, -1.0L))) return 0;

    if (ceil(1.5) != 2.0 || ceilf(1.5f) != 2.0f || ceill(1.5L) != 2.0L ||
        sqrtl(4.0L) != 2.0L || fabsl(-2.5L) != 2.5L ||
        sinl(0.0L) != 0.0L || cosl(0.0L) != 1.0L || tanl(0.0L) != 0.0L ||
        asinl(0.0L) != 0.0L || acosl(1.0L) != 0.0L || atanl(0.0L) != 0.0L ||
        sinhl(0.0L) != 0.0L || coshl(0.0L) != 1.0L || tanhl(0.0L) != 0.0L ||
        asinhl(0.0L) != 0.0L || acoshl(1.0L) != 0.0L || atanhl(0.0L) != 0.0L ||
        expl(0.0L) != 1.0L || exp2l(0.0L) != 1.0L || expm1l(0.0L) != 0.0L ||
        logl(1.0L) != 0.0L || log2l(8.0L) != 3.0L || log10l(100.0L) != 2.0L ||
        log1pl(0.0L) != 0.0L || floorl(1.5L) != 1.0L || ceill(1.5L) != 2.0L ||
        truncl(-1.5L) != -1.0L || roundl(0.5L) != 1.0L || cbrtl(8.0L) != 2.0L ||
        fmodl(5.5L, 2.0L) != 1.5L || powl(2.0L, 3.0L) != 8.0L ||
        atan2l(0.0L, 1.0L) != 0.0L || hypotl(3.0L, 4.0L) != 5.0L ||
        fminl(2.0L, 3.0L) != 2.0L || fmaxl(2.0L, 3.0L) != 3.0L ||
        fdiml(3.0L, 2.0L) != 1.0L || copysignl(2.0L, -1.0L) != -2.0L) return 0;

    long double extended_power = powl(2.0L, 63.0L) + 1.0L;
    long double tiny = powl(2.0L, -16400.0L);
    long double large_finite = expl(10000.0L);
    if (extended_power - 0x1p63L != 1.0L) return 0;
    if (!(logl(1.0L + 0x1p-63L) > 0.0L && logl(1.0L + 0x1p-63L) < 0x1p-62L)) return 0;
    if (!(tiny > 0.0L && tiny < LDBL_MIN)) return 0;
    if (!isfinite(large_finite) || fpclassify(large_finite) != FP_NORMAL) return 0;
    if (fpclassify(tiny) != FP_SUBNORMAL || !isfinite(tiny) || isnormal(tiny)) return 0;
    if (!(sinl(0x1p16000L) >= -1.0L && sinl(0x1p16000L) <= 1.0L)) return 0;
    if (!isinf(expl(16384.0L)) || !isnan(sqrtl(-1.0L))) return 0;
    if (!signbit(copysignl(0.0L, -1.0L))) return 0;
    if (!signbit(sinl(-0.0L)) || !signbit(truncl(-0.5L)) ||
        !signbit(fmodl(-4.0L, 2.0L)) || !signbit(atan2l(-0.0L, 1.0L))) return 0;
    if (roundl(-0.5L) != -1.0L) return 0;
    if (!isinf(atanhl(1.0L)) || signbit(atanhl(1.0L)) ||
        !isinf(atanhl(-1.0L)) || !signbit(atanhl(-1.0L))) return 0;
    if (!isinf(log1pl(-1.0L)) || !signbit(log1pl(-1.0L))) return 0;

    return 1;
}
