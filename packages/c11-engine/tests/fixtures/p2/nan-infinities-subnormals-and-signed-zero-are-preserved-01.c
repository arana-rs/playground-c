#include <math.h>
int main(void) { double n = NAN; double p = INFINITY; float z = -0.0f;
  return isnan(n) && n != n && !(n == n) && !(n < 1.0) && isinf(p) && !isfinite(p) &&
    isfinite(3.0) && isnormal(1.0) && !isnormal(0.0) && signbit(z) && z == 0.0f &&
    signbit(copysign(0.0, -1.0)) && fpclassify(n) == FP_NAN && fpclassify(p) == FP_INFINITE &&
    fpclassify(z) == FP_ZERO && fpclassify(0x1p-149f) == FP_SUBNORMAL && fpclassify(1.0) == FP_NORMAL &&
    isnan(sqrt(-1.0)) && isinf(1.0 / 0.0) && isnan(0.0 / 0.0) &&
    fmin(n, 3.0) == 3.0 && fmax(3.0, n) == 3.0; }