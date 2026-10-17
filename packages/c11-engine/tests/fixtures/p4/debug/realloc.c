#include <stdlib.h>

int main(void) {
    int *values = realloc(NULL, sizeof(int));
    if (values == NULL) return 1;
    values[0] = 7;

    int *resized = realloc(values, 2 * sizeof(int));
    if (resized == NULL) return 2;
    resized[1] = 9;
    return resized[0] == 7 ? 0 : 3;
}
