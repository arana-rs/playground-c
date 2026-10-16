#include <stdio.h>

int main(void) {
    int first = getchar();
    int second = getchar();
    int third = getchar();
    int ended = feof(stdin);
    printf("%d,%d,%d,%d\n", first, second, third, ended);
    return 0;
}
