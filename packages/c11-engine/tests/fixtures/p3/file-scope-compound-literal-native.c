
    struct Pair { int left; int right; };
    struct Pair *pair = &(struct Pair) { 19, 23 };
    int main(void) {
      pair->left += 1;
      return pair->left + pair->right == 43;
    }
  