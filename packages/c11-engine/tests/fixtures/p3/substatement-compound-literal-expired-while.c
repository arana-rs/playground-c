
    struct Sample { int value; };
    int main(void) {
      struct Sample *expired = 0;
      while (1) {
        expired = &(struct Sample) { 42 };
        break;
      }
      return expired->value;
    }
  