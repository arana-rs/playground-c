struct Pair { int left; int right; };

static void inner(int * restrict pointer) {
    *pointer += 1;
}

static void outer(int * restrict pointer) {
    inner(pointer);
    *pointer += 1;
}

static void copied_alias(int * restrict pointer) {
    int *copy = pointer;
    *copy = 3;
    *pointer += 1;
}

static void write_disjoint(int * restrict left, int * restrict right) {
    *left = 4;
    *right = 5;
}

static void read_only_alias(const int * restrict restricted, const int *plain) {
    (void)*restricted;
    (void)*plain;
}

static void no_object_access(int * restrict left, int * restrict right) {
    (void)left;
    (void)right;
}

int main(void) {
    int values[2] = { 0, 0 };
    struct Pair pair = { 0, 0 };
    int shared = 2;
    write_disjoint(&values[0], &values[1]);
    write_disjoint(&pair.left, &pair.right);
    outer(&shared);
    copied_alias(&shared);
    read_only_alias(&shared, &shared);
    no_object_access(&shared, &shared);
    return values[0] == 4 && values[1] == 5 && pair.left == 4 &&
        pair.right == 5 && shared == 4;
}
