
    struct Pair { int left; int right; };
    struct Pair adjust(struct Pair value) {
      value.left += 1;
      return value;
    }
    int sum(struct Pair value) { return value.left + value.right; }
    int main(void) {
      struct Pair original = { 20, 22 };
      struct Pair copy = original;
      struct Pair changed = adjust(copy);
      struct Pair *view = &changed;
      return original.left == 20 && original.right == 22 && copy.left == 20 &&
        changed.left == 21 && changed.right == 22 && view->left == 21 &&
        view->right == 22 && sum(original) == 42;
    }
  