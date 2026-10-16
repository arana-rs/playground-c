
    struct Pair { int left; int right; };
    struct Pair *pair = &(struct Pair) { .left = 19, .right = 23 };
    int main(void) {
      pair->left += 1;
      return pair->left + pair->right == 43;
    }
  