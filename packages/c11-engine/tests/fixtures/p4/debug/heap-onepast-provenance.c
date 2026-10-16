#include <stdlib.h>
#include <string.h>

int main(void) {
  int *values = malloc(4 * sizeof(int));
  if (!values) return 1;
  int *one_past = values + 4;
  unsigned char representation[8];
  memcpy(representation, &one_past, 8);
  int *neighbor = malloc(sizeof(int));
  if (!neighbor) return 2;
  *neighbor = 23;
  int *copy;
  memcpy(&copy, representation, 8);
  return *copy;
}
