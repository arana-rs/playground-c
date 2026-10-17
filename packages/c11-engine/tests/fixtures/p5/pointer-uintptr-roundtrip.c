#include <stdint.h>

int main(void) {
    int object = 7;
    uintptr_t bits = (uintptr_t)&object;
    void *roundtrip = (void *)bits;
    return roundtrip == (void *)&object;
}
