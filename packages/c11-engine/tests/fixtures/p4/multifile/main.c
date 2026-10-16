#include "value.h"

int main(void) {
    return shared_sum() == 42 && private_probe() == 0;
}
