#include <stdio.h>

struct Node {
    int value;
    struct Node *next;
};

void show(const struct Node *start) {
    const struct Node *current = start;

    while (current != 0) {
        printf("%d", current->value);
        if (current->next != 0) {
            printf(" -> ");
        }
        current = current->next;
    }

    printf("\n");
}

int main(void) {
    struct Node second = {20, 0};
    struct Node first = {10, &second};

    show(&first);
    return 0;
}
