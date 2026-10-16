int main(void) {
  int total = 0;
  {
    char first[60000];
    first[0] = 7;
    total += first[0];
  }
  {
    char second[60000];
    second[0] = 8;
    total += second[0];
  }
  return total;
}
