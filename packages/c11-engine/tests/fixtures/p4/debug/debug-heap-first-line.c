#include <stdlib.h>

int main(void) {
    int *pointer = malloc(sizeof(int));
    return pointer == NULL ? 1 : 0;
}
