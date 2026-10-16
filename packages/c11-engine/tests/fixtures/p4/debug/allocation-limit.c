#include <stdlib.h>

int main(void) {
    int *pointer = NULL;
    pointer = malloc(2 * sizeof(int));
    return pointer == NULL ? 0 : 1;
}
