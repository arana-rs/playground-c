
    struct Pair { int left; int right; };
    struct Pair update(struct Pair pair) { pair.left += 1; return pair; }
    int sum(struct Pair pair) { return pair.left + pair.right; }
    int main(void) {
      struct Pair first = { .right = 22, .left = 20 };
      struct Pair copy = first;
      struct Pair changed = update(copy);
      return first.left == 20 && copy.left == 20 && changed.left == 21 &&
        changed.right == 22 && sum(first) == 42;
    }
  