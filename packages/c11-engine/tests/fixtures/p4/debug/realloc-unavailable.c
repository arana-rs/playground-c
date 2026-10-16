#include <stdlib.h>

void *realloc(void *pointer, unsigned long size);

int main(void) {
    int *value = malloc(sizeof(int));
    if (value == NULL) return 1;
    value[0] = 7;
    void *resized = realloc(value, 2 * sizeof(int));
    return resized == NULL ? 2 : 0;
}
