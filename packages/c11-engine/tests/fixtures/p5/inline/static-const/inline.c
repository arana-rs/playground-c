inline int next_value(void) {
    static const int value = 7;
    return value;
}

inline int const_array_value(void) {
    static const int values[2] = { 1, 2 };
    return values[0] + values[1];
}
