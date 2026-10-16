
    #include <math.h>
    int add_one(int value) { return value + 1; }
    int apply(int (*operation)(int), int value) { return operation(value); }
    int main(void) {
      int (*operation)(int) = add_one;
      int (*empty)(int) = 0;
      double (*root)(double) = sqrt;
      return operation(40) == 41 && apply(operation, 41) == 42 && empty == 0 && root(81.0) == 9.0;
    }
  