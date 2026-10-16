#include <ctype.h>
#include <errno.h>
#include <inttypes.h>

int main(void) {
    if (!isalpha('A') || !isdigit('7') || !isspace('\t') || !isxdigit('f')) return 1;
    if (!isupper('A') || !islower('z') || !ispunct('!') || !isprint(' ')) return 2;
    if (tolower('Q') != 'q' || toupper('q') != 'Q') return 3;

    errno = 0;
    intmax_t value = strtoimax("999999999999999999999999", 0, 10);
    return value == INTMAX_MAX && errno == ERANGE;
}
