
    struct Sample { int value; };
    int main(void) {
      struct Sample *expired = 0;
      if (1) expired = &(struct Sample) { 42 };
      return expired->value;
    }
  