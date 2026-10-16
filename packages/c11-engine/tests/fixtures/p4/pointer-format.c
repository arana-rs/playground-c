#include <stddef.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int object = 42;
    void *expected = &object;
    void *parsed = NULL;
    char text[64];

    if (snprintf(text, sizeof text, "%p", expected) < 0) return 1;
    if (sscanf(text, "%p", &parsed) != 1 || parsed != expected) return 2;

    expected = NULL;
    parsed = &object;
    if (snprintf(text, sizeof text, "%p", expected) != 3) return 3;
    if (strcmp(text, "0x0") != 0) return 4;
    if (sscanf(text, "%p", &parsed) != 1 || parsed != expected) return 5;
    return 0;
}
