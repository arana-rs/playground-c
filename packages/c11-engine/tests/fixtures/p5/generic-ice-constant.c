struct Flags {
    unsigned value : _Generic(1.0, int: 3, double: 5);
};

_Static_assert(_Generic(1L, int: 0, long: 1, default: 0), "long selected");

float global_value = 1.2 + 0.3;

int main(void) {
    struct Flags flags = { 31 };
    return flags.value == 31 && global_value == 1.5;
}
