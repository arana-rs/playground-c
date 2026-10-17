int main(void) {
  int value = 4;
  const int *read_only = &value;
  volatile int *observed = &value;
  const volatile int *combined = 1 ? read_only : observed;
  const int *same_base = 1 ? &value : read_only;
  const void *object_or_void = 1 ? read_only : (const void *)0;
  return *combined == 4 && *same_base == 4 && *(const int *)object_or_void == 4;
}
