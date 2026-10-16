
    union Number { int value; unsigned int bits; unsigned char bytes[4]; };
    union Number adjust(union Number value) { value.value += 2; return value; }
    int observe(union Number value) { return value.value; }
    int main(void) {
      union Number original = { .value = 40 };
      union Number copy = adjust(original);
      union Number *view = &copy;
      view->value += 2;
      return original.value == 40 && observe(original) == 40 && copy.value == 44 && view->value == 44 &&
        sizeof(original) == 4;
    }
  