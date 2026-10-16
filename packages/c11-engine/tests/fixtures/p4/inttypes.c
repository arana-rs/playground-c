#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    uint64_t value = UINT64_C(18446744073709551615);
    char buffer[32];
    int length = snprintf(buffer, sizeof buffer, "%" PRIu64, value);
    if (length != 20 || strcmp(buffer, "18446744073709551615") != 0) return 1;
    length = snprintf(buffer, sizeof buffer, "%" PRIx64, value);
    if (length != 16 || strcmp(buffer, "ffffffffffffffff") != 0) return 2;

    intmax_t parsed = strtoimax("9223372036854775807", 0, 10);
    if (parsed != INTMAX_MAX) return 3;

    intmax_t scanned = 0;
    if (sscanf("-9223372036854775807", "%" SCNdMAX, &scanned) != 1) return 4;
    return scanned == -INTMAX_MAX;
}
