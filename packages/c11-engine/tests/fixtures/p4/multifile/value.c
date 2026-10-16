#include "value.h"

int shared_value = 39;

static int adjustment(void) {
    return 3;
}

int shared_sum(void) {
    return shared_value + adjustment();
}
