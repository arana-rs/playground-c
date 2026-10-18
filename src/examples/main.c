#include <stdio.h>
#include <stdlib.h>
#include <time.h>

enum { COUNT = 10, LIMIT = 100 };

int main(void) {
    int numbers[COUNT];

    srand((unsigned int)time(NULL));

    for (int i = 0; i < COUNT; i++) {
        numbers[i] = rand() % LIMIT;
    }

    printf("Array with %d random numbers between 0 and %d:\n", COUNT, LIMIT - 1);
    for (int i = 0; i < COUNT; i++) {
        printf("numbers[%d] = %d\n", i, numbers[i]);
    }

    return 0;
}
