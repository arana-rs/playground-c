
    int main(void) {
      int values[3] = { 2, 4, 6 };
      int *begin = values;
      int *end = begin + 3;
      void *opaque = begin + 1;
      int *middle = opaque;
      return middle == begin + 1 && *middle == 4 && end - begin == 3 && end == begin + 3;
    }
  