#include <stdio.h>

int main(void) {
    int first = getchar();
    int second = getc(stdin);
    int third = fgetc(stdin);
    char line[4] = { 0 };
    if (fgets(line, sizeof line, stdin) == NULL) return 1;
    unsigned char bytes[3] = { 0, 0, 0 };
    size_t count = fread(bytes, 1, sizeof bytes, stdin);
    printf("chars=%c%c%c line=%s fread=%d:%c%c%c\n",
        first, second, third, line, (int)count, bytes[0], bytes[1], bytes[2]);
    return 0;
}
