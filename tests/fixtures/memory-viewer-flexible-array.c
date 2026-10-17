#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

struct Flags { unsigned int a : 3; unsigned int b : 5; };
struct Packet { int n; unsigned char data[]; };

static _Thread_local int tls = 4;

_Static_assert(offsetof(struct Packet, data) == sizeof(int), "FAM offset");

int main(void) {
    struct Flags flags = { 0 };
    struct Packet *packet = malloc(sizeof *packet + 3);
    int x = 1;
    int *selected = &_Generic(0, int: x, default: x);
    _Alignas(32) int aligned = 7;
    int input_status = 0;
    int ok = 0;

    _Generic(0, int: x, default: x) = 5;
    flags.a = 3;
    flags.b = 5;
    if (packet == NULL) return 2;
    packet->n = 3;
    packet->data[0] = 'A';
    packet->data[1] = 'B';
    packet->data[2] = 'C';

    {
        int nested = 9;
        int hold = nested - 9;
        printf("%d %d %d %d %d\n",
            (int)flags.a, (int)flags.b, (int)tls, x, (int)packet->data[0]);
        input_status = scanf("%d", &hold);
    }

    ok = input_status == 1 && flags.a == 3 && flags.b == 5 &&
        tls == 4 && x == 5 && *selected == 5 && packet->n == 3 &&
        packet->data[0] == 'A' && aligned == 7 &&
        ((uintptr_t)&aligned % 32) == 0;
    free(packet);
    return ok ? 0 : 1;
}
