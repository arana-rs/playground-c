#include <stdlib.h>
#include <string.h>

static int file_count;

static int next_static(void) {
    static int local_count;
    return ++local_count;
}

int main(void) {
    int source = 0x12345678;
    int *allocated = malloc(sizeof source);
    unsigned char first_byte;
    union Representation { float floating; unsigned int bits; } representation;
    if (allocated == NULL) return 0;
    ++file_count;
    memcpy(allocated, &source, sizeof source);
    first_byte = ((unsigned char *)allocated)[0];
    representation.floating = 1.0f;
    free(allocated);
    return file_count == 1 && next_static() == 1 && next_static() == 2 &&
        first_byte == 0x78 && representation.bits == 0x3f800000U;
}
