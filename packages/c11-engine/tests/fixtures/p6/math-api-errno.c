#include <errno.h>
#include <float.h>
#include <math.h>

int main(void)
{
    double exact_subnormal;
    long double exact_long_double_subnormal;

    if (math_errhandling != MATH_ERRNO) return 0;
    errno = 0;
    if (!isnan(acos(2.0)) || errno != EDOM) return 0;
    errno = EINVAL;
    if (!isnan(sqrt(NAN)) || errno != EINVAL) return 0;
    errno = 0;
    if (!isinf(log(0.0)) || errno != ERANGE) return 0;
    errno = 0;
    if (!isinf(exp(1000.0)) || errno != ERANGE) return 0;
    errno = EINVAL;
    if (sqrt(4.0) != 2.0 || errno != EINVAL) return 0;
    errno = EINVAL;
    exact_subnormal = ldexp(1.0, -1074);
    if (exact_subnormal != DBL_TRUE_MIN || errno != EINVAL) return 0;
    errno = EINVAL;
    exact_long_double_subnormal = ldexpl(1.0L, -16445);
    if (exact_long_double_subnormal != LDBL_TRUE_MIN || errno != EINVAL) return 0;
    errno = EINVAL;
    if (ldexp(0.0, -10000) != 0.0 || errno != EINVAL) return 0;
    errno = 0;
    if (ldexp(1.25, -1074) != DBL_TRUE_MIN || errno != ERANGE) return 0;
    errno = 0;
    if (ldexp(1.0, -1075) != 0.0 || errno != ERANGE) return 0;
    errno = EINVAL;
    if (nextafter(0.0, 1.0) != DBL_TRUE_MIN || errno != EINVAL) return 0;
    errno = EINVAL;
    if (nextafter(DBL_TRUE_MIN, 0.0) != 0.0 || errno != EINVAL) return 0;
    errno = EINVAL;
    if (nexttoward(DBL_TRUE_MIN, 0.0L) != 0.0 || errno != EINVAL) return 0;
    return 1;
}
