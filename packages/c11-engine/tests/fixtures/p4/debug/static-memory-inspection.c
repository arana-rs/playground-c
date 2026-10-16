static int global_zero;
static long global_value = 41L;
static char *global_text = "A\n\0" "1B\001A\x42\101\"\\";

int bump(void) {
    static int visits = 2;
    visits += 1;
    return visits;
}

int main(void) {
    int first = bump();
    int second = bump();
    return first == 3 && second == 4 ? 0 : 1;
}
