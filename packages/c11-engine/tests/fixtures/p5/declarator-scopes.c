typedef int T;

int parameter_hides_typedef(int T) {
  T = sizeof(T);
  return T == sizeof(int);
}

int definition_scope_tag(struct S { int value; } s) {
  struct S local = { 1 };
  return local.value;
}

void nested_prototype_scope(void (*callback)(struct Hidden *));
struct Hidden { int value; };

int main(void) {
  int T = sizeof(T), value = sizeof(T);
  for (int T = 0; T < 2; ++T) {
    (void)sizeof(T);
  }
  return parameter_hides_typedef(1) && T == sizeof(int) && value == sizeof(int) ? 1 : 0;
}
