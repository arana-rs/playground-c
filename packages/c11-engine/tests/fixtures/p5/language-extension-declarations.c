unsigned static long int file_counter;
long const unsigned file_limit = 3UL;
_Thread_local static int thread_counter;

typedef long Scalar;
extern int composite_values[];
extern int composite_values[3];
int composite_values[3] = { 2, 3, 5 };

int legacy();
int call_legacy(void) { return legacy((signed char)4); }
int legacy(int value) { return value + 1; }

static int inline is_zero(void) { return file_counter == 0; }

int main(void) {
    int static local_value = 4;
    int Scalar = 6;
    {
        typedef unsigned long Scalar;
        Scalar nested_value = 7UL;
        if (nested_value != 7UL) return 0;
    }
    signed char narrow = 8;
    thread_counter = 1;
    return is_zero() && local_value == 4 && Scalar == 6 && narrow == 8 &&
        file_limit == 3UL && thread_counter == 1 && composite_values[2] == 5 &&
        call_legacy() == 5;
}
