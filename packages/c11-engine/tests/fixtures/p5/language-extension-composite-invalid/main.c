struct Node { int value; };
struct Node *increment(struct Node *node);

int main(void) {
    struct Node local = { 2 };
    return increment(&local)->value;
}
