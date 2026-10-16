#include <stdio.h>

static int first;
static int second;
static int consumed;
static int destination_calls;

static int *next_destination(void) {
    destination_calls++;
    return &first;
}

int main(void) {
    printf("Number: ");
    int assigned = scanf("%d%n%d", next_destination(), &consumed, &second);
    printf("first=%d consumed=%d second=%d assigned=%d calls=%d\n",
        first, consumed, second, assigned, destination_calls);
    return 0;
}
