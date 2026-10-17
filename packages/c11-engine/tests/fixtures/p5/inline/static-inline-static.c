static inline int next_value(void) {
    static int value;
    return ++value;
}

int main(void) {
    return next_value() == 1 && next_value() == 2;
}
