
    struct Record {
      int tag;
      struct { int left; int right; };
      union { int code; unsigned int bits; };
    };
    int main(void) {
      struct Record record = { .tag = 1, .left = 20, .right = 22, .code = 42 };
      return record.tag == 1 && record.left + record.right == record.code;
    }
  