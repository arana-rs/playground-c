#include <stdio.h>

int main(void) {
    float value = 0.0f;
    char next = 'X';
    int integer = 0;

    if (sscanf("1_", "%f%c", &value, &next) != 2 || value != 1.0f || next != '_') return 1;
    if (sscanf("2.5_", "%f%c", &value, &next) != 2 || value != 2.5f || next != '_') return 2;

    if (sscanf("nan(payload_7)_", "%f%c", &value, &next) != 2 || value == value || next != '_') return 3;
    if (sscanf("nan(payload_7)_", "%14f%c", &value, &next) != 2 || value == value || next != '_') return 4;
    if (sscanf("nan(payload_7)", "%3f%c", &value, &next) != 2 || value == value || next != '(') return 5;

    if (sscanf("1.", "%f", &value) != 1 || value != 1.0f) return 6;
    if (sscanf(".5", "%f", &value) != 1 || value != 0.5f) return 7;
    if (sscanf("1e+", "%f", &value) != 0) return 8;

    if (sscanf("42abc", "%d%c", &integer, &next) != 2 || integer != 42 || next != 'a') return 9;
    if (sscanf("0x2a!", "%i%c", &integer, &next) != 2 || integer != 42 || next != '!') return 10;
    if (sscanf("017!", "%i%c", &integer, &next) != 2 || integer != 15 || next != '!') return 11;
    if (sscanf("778", "%o%c", &integer, &next) != 2 || integer != 63 || next != '8') return 12;
    if (sscanf("1+2", "%d%c", &integer, &next) != 2 || integer != 1 || next != '+') return 13;
    if (sscanf("-12!", "%d%c", &integer, &next) != 2 || integer != -12 || next != '!') return 14;
    if (sscanf("+", "%d", &integer) != 0 || sscanf("0x", "%i", &integer) != 0) return 15;
    return 0;
}
