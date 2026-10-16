#include <stdarg.h>

static int collect(int count, ...) {
    va_list original;
    va_list copy;
    va_start(original, count);
    va_copy(copy, original);

    int first = va_arg(original, int);
    double promoted = va_arg(original, double);
    int third = va_arg(original, int);
    int from_copy = va_arg(copy, int);
    int second_from_copy = va_arg(copy, double) == 2.5;

    va_end(copy);
    va_end(original);
    return count == 3 && first == 9 && promoted == 2.5 &&
        third == 33 && from_copy == 9 && second_from_copy;
}

int main(void) {
    short small = 9;
    float promoted = 2.5f;
    return collect(3, small, promoted, 33);
}
