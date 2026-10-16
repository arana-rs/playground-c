#include <stdlib.h>
    int main(void) {
      int *value = malloc(sizeof(int));
      if (value == 0) return 0;
      free(value);
      free(value);
      return 0;
    }
  