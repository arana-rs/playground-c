
    #include <stddef.h>
    int main(void) {
      int values[2];
      size_t count = sizeof(values) / sizeof(values[0]);
      ptrdiff_t distance = &values[1] - &values[0];
      void *none = NULL;
      return count == 2 && distance == 1 && none == 0;
    }
  