#include <stdlib.h>

int main(void) {
  void *block = malloc(65521);
  if (block != NULL) return 1;
  return 0;
}
