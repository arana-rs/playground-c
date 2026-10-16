
    struct Pair { int left; int right; };
    int main(void) {
      struct Pair *pair = &(struct Pair) { .right = 4, .left = 3 };
      pair->left += pair->right;
      return pair->left == 7 && pair->right == 4;
    }
  