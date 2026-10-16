#include <stddef.h>
    int main(void) {
      int values[2] = { 4, 8 };
      size_t bytes = sizeof(values);
      ptrdiff_t distance = &values[1] - values;
      void *null_pointer = NULL;
      return sizeof(size_t) == 8 && sizeof(ptrdiff_t) == 8 && bytes == 8 &&
        distance == 1 && null_pointer == 0;
    }
  