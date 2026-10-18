enum Status { INACTIVE, READY = 4, COMPLETE };

int adjust(int parameter) {
    int local = parameter;
    local += 1;
    return local;
}

int main(void) {
    long long_value = 9007199254740993L;
    long long very_long = -9223372036854775807LL - 1LL;
    unsigned long long unsigned_value = 18446744073709551615ULL;
    _Bool active = 9;
    char letter = 'C';
    char newline = '\n';
    char quote = '\'';
    short short_value = -1234;
    float decimal_value = 3.5f;
    double precision_value = 2.718281828459045;
    double negative_zero = -0.0;
    enum Status status = READY;
    int uninitialized;
    int mutable = 1;
    {
        short temporary = 27;
        mutable = 2;
    }
    int result = adjust(mutable);
    return result == 3 ? 0 : 1;
}
