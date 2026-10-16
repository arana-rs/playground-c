#include <stdlib.h>
    int main(void) {
      int *value = malloc(2 * sizeof(int));
      if (value == 0) return 0;
      free(value + 1);
      return 0;
    }
  