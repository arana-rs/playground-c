#include <stdlib.h>

int main(void) {
    int *values = malloc(2 * sizeof(int));
    if (values == NULL) return 1;
    values[0] = 11;
    free(values + 1);
    return 0;
}
