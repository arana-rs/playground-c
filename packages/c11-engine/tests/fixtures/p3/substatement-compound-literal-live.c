
    struct Sample { int value; };
    int read(struct Sample *sample) { return sample->value; }
    int main(void) {
      int value = 0;
      if (1) value = read(&(struct Sample) { 42 });
      for (int index = 0; index < 2; ++index) {
        if (index == 0) continue;
        value += index;
      }
      return value == 43;
    }
  