#include <stdarg.h>

int old_style();

int old_style(value)
    signed char value;
{
    return value;
}

int no_arguments(void) {
    return 7;
}

static double promoted_values(int marker, ...) {
    va_list arguments;
    double floating;
    int narrow;
    va_start(arguments, marker);
    floating = va_arg(arguments, double);
    narrow = va_arg(arguments, int);
    va_end(arguments);
    return floating + narrow;
}

int main(void) {
    signed char value = -5;
    float fraction = 1.25f;
    return old_style(value) == -5 && no_arguments() == 7 &&
        promoted_values(0, fraction, value) == -3.75;
}
