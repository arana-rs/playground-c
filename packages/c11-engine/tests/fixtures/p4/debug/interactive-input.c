#include <stdio.h>

int main(void) {
    int value = 0;
    int scanned = scanf("%d", &value);
    int doubled = value * 2;
    return scanned == 1 && doubled == 42 ? 0 : 1;
}
