#include <stddef.h>
#include <stdarg.h>

typedef int Pair[2];
typedef int *IntPointer;

static int first_element(int values[2]) {
    return values[0];
}

static int invoke(int callback(int), int value) {
    return callback(value);
}

static int plus_one(int value) {
    return value + 1;
}

int compatible_parameter(int value);

int compatible_parameter(const int value) {
    return value;
}

static int sum_disjoint(size_t count, int * restrict destination,
                        const int * restrict source) {
    size_t index;
    for (index = 0; index < count; ++index) destination[index] += source[index];
    return destination[0] + destination[count - 1];
}

static double promoted_arguments(int count, ...) {
    va_list arguments;
    double floating;
    int narrow;
    va_start(arguments, count);
    floating = va_arg(arguments, double);
    narrow = va_arg(arguments, int);
    va_end(arguments);
    return floating + narrow;
}

int main(void) {
    int left[2] = { 3, 5 };
    const int right[2] = { 7, 11 };
    int * const fixed_pointer = &left[0];
    const int *read_only_pointer = right;
    volatile int observed = 2;
    signed char small = -3;
    float fraction = 1.5f;
    int sum = sum_disjoint(2, left, read_only_pointer);
    int mutable = 9;
    const int *read_only = &mutable;
    *(int *)read_only = 10;
    const Pair fixed_values = { 4, 6 };
    const IntPointer fixed_pointer_alias = &mutable;
    observed += 1;
    return fixed_pointer[0] == 10 && sum == 26 && observed == 3 &&
        promoted_arguments(2, fraction, small) == -1.5 &&
        mutable == 10 && first_element(left) == 10 && invoke(plus_one, 4) == 5 &&
        compatible_parameter(6) == 6 && fixed_values[1] == 6 &&
        *fixed_pointer_alias == 10;
}
