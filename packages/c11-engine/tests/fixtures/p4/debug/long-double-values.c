struct Box {
    char marker;
    long double precise;
};

int main(void) {
    long double precise = 1.0L + 0x1p-63L;
    long double values[2] = { precise, -0.0L };
    struct Box box;
    box.marker = 1;
    box.precise = precise;
    long double negative_zero = -0.0L;
    box.marker = 2;
    return 0;
}
