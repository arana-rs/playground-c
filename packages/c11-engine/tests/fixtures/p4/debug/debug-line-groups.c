int main(void) {
    int first = 1; { int same_line = first; }
    if (first == 1) { int selected = 2; } else { int skipped = 3; }
    return 0;
}
