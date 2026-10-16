
    int main(void) {
      char *text = "abc";
      int value = 0;
      unsigned char *bytes = (unsigned char *)&value;
      bytes[0] = 42;
      return sizeof("abc") == 4 && text[3] == '\0' && value == 42 &&
        bytes[0] == 42 && bytes[1] == 0 && bytes[2] == 0 && bytes[3] == 0;
    }
  