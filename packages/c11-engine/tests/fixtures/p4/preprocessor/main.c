#define FEATURE_ON 1
#define LOCAL_HEADER "include/value.h"
#include LOCAL_HEADER
#include "include/value.h"

#define VALUE 20
#define VALUE42 42
#define JOIN(left, right) left ## right
#define STRINGIZE(value) #value
#define STRINGIZE_EXPANDED(value) STRINGIZE(value)
#define SUM(first, second) ((first) + (second))
#define FORWARD(...) SUM(__VA_ARGS__)
#define WRAP(value) FORWARD(value, FROM_HEADER)
#define REMOVE_ME 7
#undef REMOVE_ME

#ifdef REMOVE_ME
#error REMOVE_ME must stay undefined
#endif

int main(void) {
    int JOIN(item, 42) = 42;
    int rescanned = JOIN(VALUE, 42);
    const char *literal = STRINGIZE(VALUE);
    const char *expanded = STRINGIZE_EXPANDED(VALUE);
    return WRAP(VALUE) == 62 && item42 == 42 && rescanned == 42 &&
        literal[0] == 'V' && expanded[0] == '2' && expanded[1] == '0';
}
