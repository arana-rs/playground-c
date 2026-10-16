#include <stdlib.h>

int main(void) {
    int *values = malloc(4 * sizeof(int));
    if (values == NULL) return 1;
    values[0] = 21;
    free(values);
    free(NULL);
    return 0;
}
