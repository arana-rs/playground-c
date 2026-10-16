static int global_value = 41;
static int *global_alias = &global_value;

int main(void) {
    int local_value = *global_alias;
    int copied_value = local_value;
    return copied_value == 41 ? 0 : 1;
}
