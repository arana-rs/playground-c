#include <errno.h>
#include <math.h>

int main(void)
{
    errno = EDOM;
    if (!isnan(sqrtl(-1.0L)) || errno != EDOM) return 0;
    if (!isnan(asinl(2.0L)) || errno != EDOM) return 0;
    if (!isnan(logl(-1.0L)) || errno != EDOM) return 0;

    errno = ERANGE;
    if (!isinf(expl(16384.0L)) || errno != ERANGE) return 0;
    if (expl(-16400.0L) != 0.0L || errno != ERANGE) return 0;

    return 1;
}
