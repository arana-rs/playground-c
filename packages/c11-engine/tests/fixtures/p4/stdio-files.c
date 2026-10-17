#include <stdio.h>

int main(void) {
    FILE *input = fopen("input.bin", "rb");
    if (input == 0) return 1;
    if (fgetc(input) != 'A') return 2;
    if (ungetc('X', input) == EOF || ftell(input) != 0) return 3;
    if (fgetc(input) != 'X' || ftell(input) != 1) return 4;
    if (fseek(input, 0, SEEK_SET) != 0) return 5;
    unsigned char bytes[4] = { 0, 0, 0, 0 };
    if (fread(bytes, 1, 4, input) != 3) return 6;
    if (bytes[0] != 'A' || bytes[1] != 0 || bytes[2] != 'B') return 7;
    if (fgetc(input) != EOF || !feof(input) || ferror(input)) return 8;
    if (ungetc('Z', input) == EOF || feof(input) || fgetc(input) != 'Z') return 9;
    if (fseek(input, 2, SEEK_SET) != 0 || ftell(input) != 2) return 10;
    if (fgetc(input) != 'B' || fclose(input) != 0) return 11;

    FILE *output = fopen("output.bin", "w+b");
    if (output == 0) return 12;
    const unsigned char expected[3] = { 0, 'X', 'Y' };
    if (fwrite(expected, 1, 3, output) != 3) return 13;
    if (fflush(output) != 0 || fseek(output, 0, SEEK_SET) != 0) return 14;
    unsigned char actual[3] = { 1, 1, 1 };
    if (fread(actual, 1, 3, output) != 3) return 15;
    if (fclose(output) != 0) return 16;
    return actual[0] == 0 && actual[1] == 'X' && actual[2] == 'Y';
}
