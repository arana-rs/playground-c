#include <string.h>

int main(int argc, char **argv) {
    return argc == 3 && argv[0][0] != '\0' &&
        strcmp(argv[1], "north") == 0 && strcmp(argv[2], "42") == 0 &&
        argv[argc] == 0;
}
