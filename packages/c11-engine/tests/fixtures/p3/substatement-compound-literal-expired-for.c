
    struct Sample { int value; };
    int main(void) {
      struct Sample *expired = 0;
      int index = 0;
      for (; index < 2 && (!expired || expired->value == 42); ++index)
        expired = &(struct Sample) { 42 };
      return 0;
    }
  