#include <stdarg.h>
#include <string.h>

struct Box {
    char tag;
    long double value;
};

union Choice {
    long double value;
    unsigned char bytes[16];
};

static long double pass(long double value) {
    return value;
}

static long double read_variadic(int count, ...) {
    va_list args;
    va_start(args, count);
    long double value = va_arg(args, long double);
    va_end(args);
    return value;
}

int main(void) {
    long double exact = 1.0L + 0x1p-63L;
    long double values[2] = { exact, -0.0L };
    struct Box box;
    box.tag = 7;
    box.value = pass(read_variadic(1, values[0]));

    union Choice choice;
    choice.value = box.value;
    union Choice copy = choice;
    unsigned char representation[16];
    long double restored;
    memcpy(representation, &copy.value, sizeof(long double));
    memcpy(&restored, representation, sizeof(long double));
    ((unsigned char *)&restored)[15] = 0xff;

    if (sizeof(long double) != 16 || sizeof(struct Box) != 32 || sizeof(union Choice) != 16) return 1;
    if (exact == 1.0L || values[0] == 1.0L || values[1] != 0.0L || values[1]) return 2;
    if (box.tag != 7 || box.value != exact || copy.value != exact || restored != exact) return 3;
    return 0;
}
