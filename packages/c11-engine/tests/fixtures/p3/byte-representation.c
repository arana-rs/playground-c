int main(void) { 
    int value = 0;
    unsigned char *bytes = (unsigned char *)&value;
    bytes[0] = 42;
    return value == 42 && bytes[0] == 42 && bytes[1] == 0 && bytes[2] == 0 && bytes[3] == 0;
   }