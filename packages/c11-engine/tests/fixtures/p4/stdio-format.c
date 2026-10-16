#include <stdio.h>
#include <string.h>

int main(void) {
    char buffer[64];
    int length = snprintf(buffer, sizeof buffer, "%s:%d:%#x", "ok", 42, 42);
    return length == 10 && buffer[length] == '\0' && strcmp(buffer, "ok:42:0x2a") == 0;
}
