#include <stdlib.h>
    int main(void) {
      free(0);
      void *zero_size = malloc(0);
      free(zero_size);
      {
        int *values = malloc(3 * sizeof(int));
        if (values == 0) return 0;
        values[0] = 17;
        values[1] = 25;
        values[2] = values[0] + values[1];
        if (values[2] != 42) return 2;
        free(values);
      }
      return 1;
    }
  