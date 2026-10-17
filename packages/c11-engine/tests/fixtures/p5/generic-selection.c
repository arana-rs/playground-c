typedef int Number;

int increment(int value) { return value + 1; }
int unselected_effects;

int unselected(void) {
    ++unselected_effects;
    return 99;
}

int main(void) {
    const int source = 4;
    int side_effect = 0;
    int selected = _Generic((side_effect++, source), Number: 20, default: 30);
    int array[2] = { 3, 5 };
    int array_kind = _Generic(array, int *: 1, default: 0);
    int function_kind = _Generic(increment, int (*)(int): 1, default: 0);
    int branch_kind = _Generic(1.0f, float: 1, double: 0, default: 2);
    int unselected_branch = _Generic(1, int: 6, default: unselected());
    return selected == 20 && side_effect == 0 && array_kind == 1 &&
        function_kind == 1 && branch_kind == 1 && array[1] == 5 &&
        unselected_branch == 6 && unselected_effects == 0;
}
