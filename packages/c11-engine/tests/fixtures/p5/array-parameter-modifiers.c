static int sum_minimum(const int values[static 3]) {
    return values[0] + values[1] + values[2];
}

static int first_const_pointer(const int values[const 3]) {
    return values[0];
}

static int increment_restricted(int values[restrict static 3]) {
    values[0] += 1;
    return values[0];
}

static int last_const_static(const int values[const static 3]) {
    return values[2];
}

int main(void) {
    int values[3] = { 2, 3, 5 };
    return sum_minimum(values) == 10 && first_const_pointer(values) == 2 &&
        increment_restricted(values) == 3 && last_const_static(values) == 5;
}
