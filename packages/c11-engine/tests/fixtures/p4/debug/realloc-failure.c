#include <stdlib.h>

int main(void) {
    int *values = malloc(sizeof(int));
    if (values == NULL) return 1;
    values[0] = 7;

    int *resized = realloc(values, 65521);
    if (resized != NULL) return 2;
    return values[0] == 7 ? 0 : 3;
}
