#include <stdlib.h>
    struct Word { unsigned int value; };
    int main(void) {
      struct Word local = { .value = 0x12345678U };
      unsigned char *local_bytes = (unsigned char *)&local;
      struct Word *heap = malloc(sizeof(struct Word));
      if (heap == 0) return 0;
      *heap = (struct Word) { .value = 0x12345678U };
      unsigned char *heap_bytes = (unsigned char *)heap;
      int matches = local_bytes[0] == 0x78 && local_bytes[1] == 0x56 &&
        local_bytes[2] == 0x34 && local_bytes[3] == 0x12 &&
        heap_bytes[0] == 0x78 && heap_bytes[1] == 0x56 &&
        heap_bytes[2] == 0x34 && heap_bytes[3] == 0x12;
      free(heap);
      return matches;
    }
  