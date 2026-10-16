#include <stdlib.h>

int main(void) {
  void *first = malloc(4);
  void *second = malloc(8);
  void *third = malloc(12);
  free(second);
  void *replacement = malloc(6);
  free(first);
  free(third);
  free(replacement);
  return 0;
}
