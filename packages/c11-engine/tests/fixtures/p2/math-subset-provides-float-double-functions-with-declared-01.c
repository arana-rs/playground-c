#include <math.h>
int main(void) { return sqrt(81.0) == 9.0 && sqrtf(81.0f) == 9.0f &&
  fabs(-2.5) == 2.5 && fmod(-7.0, 3.0) == -1.0 && pow(2.0, 10.0) == 1024.0 &&
  sin(0.0) == 0.0 && cos(0.0) == 1.0 && tan(0.0) == 0.0 && exp(0.0) == 1.0 && log(1.0) == 0.0 &&
  floor(-2.5) == -3.0 && ceil(-2.5) == -2.0 && trunc(-2.5) == -2.0 &&
  fmin(2.0, 3.0) == 2.0 && fmax(2.0, 3.0) == 3.0 && copysign(2.0, -1.0) == -2.0 &&
  sizeof(sqrtf(1.0f)) == 4 && sizeof(sqrt(1.0)) == 8; }