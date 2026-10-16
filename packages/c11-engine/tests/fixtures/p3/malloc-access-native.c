
    #include <stdlib.h>
    int main(void) {
      int *values = malloc(2 * sizeof(int));
      if (values == 0) return 0;
      values[0] = 17;
      values[1] = 25;
      int result = values[0] + values[1];
      free(values);
      return result == 42;
    }
  