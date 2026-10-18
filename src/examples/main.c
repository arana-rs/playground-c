#include <stdio.h>
#include <stdlib.h>
#include <time.h>

enum { COUNT = 10, LIMIT = 100, POINTER_COUNT = 3, READING_COUNT = 3 };

struct Reading {
    int sensor;
    int value;
};

int main(void) {
    int numbers[COUNT];
    int *number_targets[POINTER_COUNT] = { NULL, NULL, NULL };
    struct Reading readings[READING_COUNT] = {
        { 1, 24 },
        { 2, 37 },
        { 3, 52 }
    };

    srand((unsigned int)time(NULL));

    for (int i = 0; i < COUNT; i++) {
        numbers[i] = rand() % LIMIT;
    }

    number_targets[0] = &numbers[0];
    number_targets[1] = numbers + COUNT - 1;

    printf("Array with %d random numbers between 0 and %d:\n", COUNT, LIMIT - 1);
    for (int i = 0; i < COUNT; i++) {
        printf("numbers[%d] = %d\n", i, numbers[i]);
    }

    printf("Pointer array: first=%d, last=%d, third=%s\n",
        *number_targets[0], *number_targets[1],
        number_targets[2] == NULL ? "NULL" : "non-NULL");
    printf("Struct array: [%d:%d], [%d:%d], [%d:%d]\n",
        readings[0].sensor, readings[0].value,
        readings[1].sensor, readings[1].value,
        readings[2].sensor, readings[2].value);

    return 0;
}
