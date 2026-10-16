int main(void) {
  int *stale;
  {
    int old_value = 1;
    stale = &old_value;
  }
  {
    int new_value = 2;
    return *stale + new_value;
  }
}
