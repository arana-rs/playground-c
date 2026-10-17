#include <stdlib.h>

struct Pair {
    int left;
    int right;
};

int main(void) {
    unsigned char *storage = malloc(32);
    struct Pair *first;
    struct Pair *second;
    if (storage == 0) return 0;
    first = (struct Pair *)(storage + 8);
    second = (struct Pair *)(storage + 20);
    first->left = 11;
    first->right = 12;
    second->left = 21;
    second->right = 22;
    return first->left + second->right == 33;
}
