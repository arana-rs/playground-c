#include <stddef.h>

int main(void) {
    int n = 10;
    int other = 30;
    int *uninitialized;
    int *p = &n;
    *p = 20;
    int read_value = *p;
    p = &other;
    *p = 40;
    p = NULL;
    return 0;
}
