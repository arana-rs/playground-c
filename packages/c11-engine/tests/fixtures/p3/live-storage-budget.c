#include <stdlib.h>
    int main(void) {
      {
        int *values = malloc(2 * sizeof(int));
        if (values == 0) return 0;
        values[0] = 17;
        values[1] = 25;
        free(values);
      }
      {
        int *value = malloc(2 * sizeof(int));
        if (value == 0) return 0;
        *value = 42;
        free(value);
      }
      return 1;
    }
  