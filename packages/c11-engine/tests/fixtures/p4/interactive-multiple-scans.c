#include <stdio.h>

int main(void) {
    int first = 0;
    int second = 0;
    printf("First: ");
    int first_count = scanf("%d", &first);
    printf("first=%d count=%d\nSecond: ", first, first_count);
    int second_count = fscanf(stdin, "%d", &second);
    printf("second=%d count=%d\n", second, second_count);
    return 0;
}
