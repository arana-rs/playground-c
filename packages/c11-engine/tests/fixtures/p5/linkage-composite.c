typedef int Scalar;
typedef int Scalar;

int old_style();
int old_style(int);
int no_arguments();
int kr_old();

extern int values[];
int values[2] = { 3, 5 };

int old_style(int value) {
    return value;
}

int no_arguments(void) {
    return 4;
}

int kr_old(value)
    int value;
{
    return value + 1;
}

int main(void) {
    Scalar value = old_style(7);
    return value == 7 && no_arguments() == 4 && kr_old(2) == 3 && values[1] == 5;
}
