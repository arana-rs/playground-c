#include <stdio.h>
#include <stdlib.h>

struct Node {
    int value;
    struct Node *next;
};

int main(void) {
    struct Node *head = NULL;

    struct Node *first = malloc(sizeof(*first));
    if (first == NULL) {
        return 1;
    }

    struct Node *second = malloc(sizeof(*second));
    if (second == NULL) {
        free(first);
        return 1;
    }

    struct Node *third = malloc(sizeof(*third));
    if (third == NULL) {
        free(second);
        free(first);
        return 1;
    }

    first->value = 10;
    first->next = NULL;
    second->value = 20;
    second->next = NULL;
    third->value = 30;
    third->next = NULL;

    printf("Nodes before linking: %d, %d, %d\n",
           first->value, second->value, third->value);

    first->next = second;
    second->next = third;
    head = first;

    struct Node *current = head;
    printf("List:");
    while (current != NULL) {
        printf(" %d", current->value);
        current = current->next;
    }
    puts("");

    current = head;
    while (current != NULL) {
        struct Node *next = current->next;
        free(current);
        current = next;
    }

    return 0;
}
