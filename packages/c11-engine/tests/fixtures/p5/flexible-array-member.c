#include <stddef.h>
#include <stdlib.h>

struct Packet {
    size_t count;
    int values[];
};

_Static_assert(offsetof(struct Packet, values) == 8, "flexible member offset");
_Static_assert(sizeof(struct Packet) == 8, "header size excludes elements");

int main(void) {
    struct Packet *packet = malloc(sizeof *packet + 3 * sizeof packet->values[0]);
    struct Packet *copy = malloc(sizeof *copy + 3 * sizeof copy->values[0]);
    int valid;
    if (packet == NULL || copy == NULL) {
        free(packet);
        free(copy);
        return 0;
    }
    packet->count = 3;
    packet->values[0] = 2;
    packet->values[1] = 3;
    packet->values[2] = 5;
    copy->count = 0;
    copy->values[0] = 99;
    *copy = *packet;
    valid = packet->count == 3 &&
        packet->values[0] + packet->values[1] + packet->values[2] == 10 &&
        copy->count == 3 && copy->values[0] == 99;
    free(packet);
    free(copy);
    return valid;
}
