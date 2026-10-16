
    union Number { int integer; unsigned int bits; };
    int main(void) {
      union Number first = { .integer = 41 };
      union Number second = first;
      second.integer += 1;
      return first.integer == 41 && second.integer == 42;
    }
  