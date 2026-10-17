#include "inline_api.h"

int scale_from_other_unit(int value);

int main(void) {
    return scale_inline(4) == 8 && local_bias(4) == 7 &&
        scale_from_other_unit(5) == 10;
}
