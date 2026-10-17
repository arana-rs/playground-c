struct Metadata { int stamp; };
struct Node { struct Metadata *metadata; int value; };
struct Node shared_node = { 0, 9 };
struct Opaque { int marker; };
struct Opaque *forward_object = 0;

struct Node increment(struct Node *node) {
    node->value += 1;
    node->metadata->stamp += 1;
    return *node;
}
