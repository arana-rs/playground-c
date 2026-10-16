#include <float.h>
#include <math.h>

int main(void) {
    float smallest_float = FLT_TRUE_MIN;
    double smallest_double = DBL_TRUE_MIN;
    if (smallest_float != 0x1p-149f || !(smallest_float > 0.0f)) return 1;
    if (fpclassify(smallest_float) != FP_SUBNORMAL) return 2;
    if (fpclassify(smallest_double) != FP_SUBNORMAL) return 3;
    return isnormal(smallest_float) || isnormal(smallest_double) ? 4 : 0;
}
