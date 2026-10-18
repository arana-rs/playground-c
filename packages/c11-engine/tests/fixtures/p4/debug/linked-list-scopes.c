struct Node {
    int value;
    struct Node *next;
};

void appendNode(struct Node **head, struct Node *node) {
    struct Node **cursor = head;
    while (*cursor != 0) {
        cursor = &(*cursor)->next;
    }
    *cursor = node;
}

int main(void) {
    struct Node first = {10, 0};
    struct Node second = {20, 0};
    struct Node third = {30, 0};
    struct Node *list = 0;

    appendNode(&list, &first);
    appendNode(&list, &second);
    appendNode(&list, &third);

    if (list != &first || first.next != &second ||
        second.next != &third || third.next != 0 ||
        first.value != 10 || second.value != 20 || third.value != 30) {
        return 1;
    }

    int temporary_is_correct = 0;
    {
        struct Node temporary = {40, 0};
        appendNode(&list, &temporary);
        temporary_is_correct = third.next == &temporary &&
            temporary.value == 40 && temporary.next == 0;
        third.next = 0;
    }

    if (temporary_is_correct == 0 || list != &first ||
        first.next != &second || second.next != &third ||
        third.next != 0) {
        return 2;
    }

    return 0;
}
