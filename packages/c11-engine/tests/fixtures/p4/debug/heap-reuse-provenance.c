#include <stdlib.h>
#include <string.h>

int main(void) {
  int *first = malloc(sizeof(int));
  if (!first) return 1;
  *first = 17;
  unsigned char representation[8];
  memcpy(representation, &first, 8);
  free(first);
  int *replacement = malloc(sizeof(int));
  if (!replacement) return 2;
  int *stale;
  memcpy(&stale, representation, 8);
  return *stale;
}
