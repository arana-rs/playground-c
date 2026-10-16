#include <stdio.h>
#include <string.h>

int main(void) {
    char line[16];
    if (fgets(line, sizeof line, stdin) == 0) return 1;
    return strcmp(line, "hello\n") == 0 && getchar() == 'X' && getchar() == EOF && feof(stdin);
}
