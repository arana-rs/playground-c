#include <stddef.h>

int main(void) {
    int n = 10;
    int otra = 30;
    int *pendiente;
    int *p = &n;
    *p = 20;
    int lectura = *p;
    p = &otra;
    *p = 40;
    p = NULL;
    return 0;
}
