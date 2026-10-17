#include <stdlib.h>

int main(void) {
    int *values = realloc(NULL, sizeof(int));
    if (values == NULL) return 1;
    values[0] = 7;

    int *grown = realloc(values, 2 * sizeof(int));
    if (grown == NULL || grown[0] != 7) return 2;
    grown[1] = 9;

    int *shrunk = realloc(grown, sizeof(int));
    if (shrunk == NULL || shrunk[0] != 7) return 3;

    int *failed = realloc(shrunk, 65521);
    if (failed != NULL || shrunk[0] != 7) return 4;
    if (realloc(shrunk, 0) != NULL || realloc(NULL, 0) != NULL) return 5;

    int *target = malloc(sizeof(int));
    void **slot = malloc(sizeof(void *));
    if (target == NULL || slot == NULL) return 6;
    target[0] = 42;
    *slot = target;
    void **grown_slot = realloc(slot, 2 * sizeof(void *));
    if (grown_slot == NULL) return 7;
    int *copied_target = *grown_slot;
    if (*copied_target != 42) return 8;

    free(grown_slot);
    free(target);
    return 1;
}
