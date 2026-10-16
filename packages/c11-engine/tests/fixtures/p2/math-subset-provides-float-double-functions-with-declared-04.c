#include <math.h>
int main(void) { return roundf(-2.5f) == -3.0f && cbrtf(8.0f) == 2.0f && hypotf(3.0f, 4.0f) == 5.0f && fdimf(2.0f, 3.0f) == 0.0f && exp2f(3.0f) == 8.0f; }