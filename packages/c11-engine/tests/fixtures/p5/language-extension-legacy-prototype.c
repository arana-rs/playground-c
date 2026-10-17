int legacy();
int legacy(void) { return 7; }

int main(void) {
  return legacy() == 7;
}
