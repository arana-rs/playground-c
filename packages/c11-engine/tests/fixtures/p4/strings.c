#include <string.h>

int main(void) {
    char text[16] = "abc";
    if (strlen(text) != 3 || strcmp(text, "abc") != 0 || strncmp(text, "abd", 2) != 0) return 1;

    char copy[16];
    memcpy(copy, text, 4);
    if (memcmp(copy, text, 4) != 0) return 2;
    memmove(copy + 1, copy, 3);
    if (copy[0] != 'a' || copy[1] != 'a' || copy[2] != 'b' || copy[3] != 'c') return 3;

    strcpy(text, "hi");
    strcat(text, "!");
    if (strcmp(text, "hi!") != 0 || strchr(text, '!') != text + 2 || strrchr(text, 'h') != text) return 4;
    if (strstr("one two", "two") == 0) return 5;

    char words[] = "red,green,,blue";
    char *first = strtok(words, ",");
    char *second = strtok(0, ",");
    char *third = strtok(0, ",");
    char *done = strtok(0, ",");
    return first != 0 && strcmp(first, "red") == 0 &&
        second != 0 && strcmp(second, "green") == 0 &&
        third != 0 && strcmp(third, "blue") == 0 && done == 0;
}
