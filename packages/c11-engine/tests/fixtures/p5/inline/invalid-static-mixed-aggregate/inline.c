struct Mixed {
    const int fixed;
    int mutable;
};

inline int read_mixed(void) {
    static struct Mixed value = { 1, 2 };
    return ++value.mutable;
}
