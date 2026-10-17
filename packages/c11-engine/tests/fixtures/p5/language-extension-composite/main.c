struct Metadata { int stamp; };
struct Node { struct Metadata *metadata; int value; };
extern struct Node shared_node;
struct Node increment(struct Node *node);
struct Opaque;
extern struct Opaque *forward_object;

int main(void) {
    struct Metadata metadata = { 5 };
    struct Node local = { &metadata, 2 };
    struct Node result = increment(&local);
    return result.value == 3 && result.metadata == &metadata && result.metadata->stamp == 6 && shared_node.value == 9;
}
