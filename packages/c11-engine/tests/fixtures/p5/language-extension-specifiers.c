unsigned static long int file_counter;
static int inline is_zero(void) { return file_counter == 0; }

struct InterleavedAlignment {
  int _Alignas(16) value;
  long const _Alignas(32) unsigned wide;
};
_Static_assert(_Alignof(struct InterleavedAlignment) == 32, "member alignment");

int main(void) {
  int static local_value = 4;
  long const unsigned limit = 3UL;
  int register parameter_order = 2;
  struct InterleavedAlignment aligned = { 5, 6UL };
  return is_zero() && local_value == 4 && limit == 3 && parameter_order == 2 &&
      aligned.value == 5 && aligned.wide == 6UL;
}
