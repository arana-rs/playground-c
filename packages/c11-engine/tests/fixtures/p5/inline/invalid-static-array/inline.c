inline int next_value(void) {
    static int values[1];
    return ++values[0];
}
