#include <stddef.h>
#include <stdalign.h>
#include <stdint.h>
#include <limits.h>

struct Layout {
    char lead;
    int value;
    double tail;
};

struct NestedLayout {
    struct Layout inner;
    int values[2];
};

_Static_assert(CHAR_BIT == 8, "profile byte width");
_Static_assert(sizeof(max_align_t) == 32, "profile max_align_t storage size");
_Static_assert(alignof(max_align_t) == 16, "profile maximum fundamental alignment");
_Static_assert(alignof(max_align_t) >= alignof(long double), "max_align_t covers long double");
_Static_assert(offsetof(struct Layout, value) == 4, "int member offset");
_Static_assert(offsetof(struct Layout, tail) == 8, "double member offset");
_Static_assert(sizeof(struct Layout) == 16, "aggregate tail padding");
_Static_assert(offsetof(struct NestedLayout, inner.tail) == 8, "nested member designator");
_Static_assert(offsetof(struct NestedLayout, values[1]) == 20, "array designator");

alignas(16) int aligned_global = 7;
alignas(0) int default_alignment = 9;

int main(void) {
    alignas(16) long double aligned_local = 1.0L;
    return ((uintptr_t)&aligned_global % 16) == 0 &&
        ((uintptr_t)&aligned_local % 16) == 0 &&
        alignof(struct Layout) == 8 && offsetof(struct Layout, tail) == 8 &&
        aligned_global == 7 && aligned_local == 1.0L && default_alignment == 9 &&
        __alignas_is_defined == 1 && __alignof_is_defined == 1;
}
