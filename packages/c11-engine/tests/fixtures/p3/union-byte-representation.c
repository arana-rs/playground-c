int main(void) { 
    union Bytes { unsigned int word; unsigned char bytes[4]; };
    union Bytes value = { .word = 0x12345678U };
    return value.bytes[0] == 0x78 && value.bytes[1] == 0x56 &&
      value.bytes[2] == 0x34 && value.bytes[3] == 0x12;
   }