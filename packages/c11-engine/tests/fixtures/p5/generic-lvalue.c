int main(void) {
    int value = 1;
    int *address = &_Generic(0, int: value, default: value);
    _Generic(0, int: value, default: value) = 5;
    ++_Generic(0, int: value, default: value);
    return *address == 6 && value == 6;
}
