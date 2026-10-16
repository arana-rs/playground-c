
    #include <math.h>
    int add_one(int value) { return value + 1; }
    int apply(int (*function)(int), int value) { return function(value); }
    int main(void) {
      int (*function)(int) = add_one;
      double (*root)(double) = sqrt;
      return function(40) == 41 && apply(function, 41) == 42 && root(81.0) == 9.0;
    }
  