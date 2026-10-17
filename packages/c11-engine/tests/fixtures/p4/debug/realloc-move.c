#include <stdlib.h>

int main(void) {
    int *first = malloc(sizeof(int));
    int *neighbor = malloc(sizeof(int));
    if (first == NULL || neighbor == NULL) return 1;
    first[0] = 11;
    neighbor[0] = 22;

    first = realloc(first, 40);
    if (first == NULL || first[0] != 11 || neighbor[0] != 22) return 2;
    first[1] = 33;

    int *reused = malloc(sizeof(int));
    if (reused == NULL) return 3;
    reused[0] = 44;
    const int result = first[0] == 11 && first[1] == 33 && neighbor[0] == 22 && reused[0] == 44;
    free(first);
    free(neighbor);
    free(reused);
    return result ? 0 : 4;
}
