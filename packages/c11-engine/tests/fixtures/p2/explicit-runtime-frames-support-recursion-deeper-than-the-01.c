static int depth;
int down(void) {
  if (depth == 3000) return 0;
  depth += 1;
  return down() + 1;
}
int main(void) { return down(); }
