#include <stdlib.h>

struct Flags {
    unsigned int ready : 1;
    unsigned int mode : 3;
    unsigned int : 0;
    unsigned int next : 2;
};

struct Packet {
    unsigned int count;
    int values[];
};

_Thread_local struct Flags thread_flags;
_Thread_local int thread_scalar;
_Thread_local int *thread_pointer;
_Thread_local int thread_array[2];

int main(void) {
    struct Flags flags = { 1, 5, 2 };
    const int immutable = 7;
    volatile int observed = 2;
    struct Packet *packet = malloc(sizeof *packet + 3 * sizeof packet->values[0]);
    if (packet == 0) return 0;
    packet->count = 3;
    packet->values[0] = 2;
    packet->values[1] = 3;
    packet->values[2] = 5;
    return flags.ready + flags.mode + flags.next + thread_flags.ready + observed + immutable + packet->values[2] == 22;
}
