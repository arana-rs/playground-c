int main(void) { _Bool b = 1; char c = 'A'; short s = 1; int i = 1; long l = 1; long long ll = 1;
    float f = 1.0f; double d = 1.0;
    return sizeof b == 1 && sizeof c == 1 && sizeof s == 2 && sizeof i == 4 &&
      sizeof l == 8 && sizeof ll == 8 && sizeof f == 4 && sizeof d == 8 &&
      sizeof(unsigned long long) == 8 && sizeof(+s) == 4 && sizeof(i + l) == 8; }