int main(void) {
    extern int shared_value;
    extern int plus_one(int value);
    return plus_one(++shared_value) == 8;
}
