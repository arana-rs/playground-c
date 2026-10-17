int scale_inline(int value);

int scale_inline(int value) {
    return value * 2;
}

int scale_from_other_unit(int value) {
    return scale_inline(value);
}
