#include <float.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char text[128];
    double parsedDouble = 0.0;
    if (snprintf(text, sizeof text, "%.0a", 3.0) != 6 || strcmp(text, "0x1p+2") != 0) return 1;
    if (snprintf(text, sizeof text, "%#.0a", 1.5) != 7 || strcmp(text, "0x1.p+1") != 0) return 2;
    if (snprintf(text, sizeof text, "%.1A", 1.5) != 8 || strcmp(text, "0X1.8P+0") != 0) return 3;
    if (snprintf(text, sizeof text, "%+010a", 1.0) != 10 || strcmp(text, "+0x0001p+0") != 0) return 4;
    if (snprintf(text, sizeof text, "%a", DBL_TRUE_MIN) < 0 || sscanf(text, "%la", &parsedDouble) != 1 || parsedDouble != DBL_TRUE_MIN) return 5;
    if (sscanf("0X1.8P+0", "%lA", &parsedDouble) != 1 || parsedDouble != 1.5) return 6;

    char scannedCharacter = 0;
    char scannedText[4] = { 0 };
    if (snprintf(text, sizeof text, "%c:%s", 'Z', "AB") != 4 || strcmp(text, "Z:AB") != 0) return 7;
    if (sscanf("Q:xy", "%c:%2s", &scannedCharacter, scannedText) != 2 || scannedCharacter != 'Q' || scannedText[0] != 'x' || scannedText[1] != 'y' || scannedText[2] != 0) return 8;

    long double precise = 1.0L + 0x1p-63L;
    long double scannedLongDouble = 0.0L;
    if (precise == 1.0L) return 9;
    if (snprintf(text, sizeof text, "%La", precise) != 23 || strcmp(text, "0x1.0000000000000002p+0") != 0) return 10;
    if (snprintf(text, sizeof text, "%LA", precise) != 23 || strcmp(text, "0X1.0000000000000002P+0") != 0) return 11;
    if (snprintf(text, sizeof text, "%.2Lf", 1.25L) != 4 || strcmp(text, "1.25") != 0) return 12;
    if (snprintf(text, sizeof text, "%.2Le", 1.25L) != 8 || strcmp(text, "1.25e+00") != 0) return 13;
    if (snprintf(text, sizeof text, "%.3Lg", 1.25L) != 4 || strcmp(text, "1.25") != 0) return 14;
    if (snprintf(text, sizeof text, "%.2LF", 1.25L) != 4 || strcmp(text, "1.25") != 0) return 15;
    if (snprintf(text, sizeof text, "%.2LE", 1.25L) != 8 || strcmp(text, "1.25E+00") != 0) return 16;
    if (snprintf(text, sizeof text, "%.3LG", 1.25L) != 4 || strcmp(text, "1.25") != 0) return 17;
    if (snprintf(text, sizeof text, "%#.4Lg", 1.25L) != 5 || strcmp(text, "1.250") != 0) return 18;
    if (sscanf("1.25", "%Lf", &scannedLongDouble) != 1 || scannedLongDouble != 1.25L) return 19;
    if (sscanf("0X1.0000000000000002P+0", "%LA", &scannedLongDouble) != 1 || scannedLongDouble != precise) return 20;
    return 0;
}
