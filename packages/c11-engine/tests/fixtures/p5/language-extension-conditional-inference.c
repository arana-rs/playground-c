enum {
    qualified_pointer_choice = _Generic(
        1 ? (const int *)0 : (int *)0,
        const int *: 3,
        default: 4
    ),
    merged_pointer_choice = _Generic(
        1 ? (const int *)0 : (volatile int *)0,
        const volatile int *: 5,
        default: 6
    )
};

int main(void) {
    return qualified_pointer_choice == 3 && merged_pointer_choice == 5;
}
