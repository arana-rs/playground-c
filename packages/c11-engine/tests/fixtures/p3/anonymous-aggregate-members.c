int main(void) { 
    struct Record {
      int tag;
      struct { int left; int right; };
      union { int code; unsigned int bits; };
    };
    struct Record record = { .right = 22, .tag = 1, .left = 20, .code = 42 };
    return record.tag == 1 && record.left == 20 && record.right == 22 && record.code == 42;
   }