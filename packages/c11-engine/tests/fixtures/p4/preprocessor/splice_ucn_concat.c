int main(void) {
    int \u03B1 = 40;
    const char *text = "C11 "
        "engine";
    return \u03B1 + 2 == 42 && text[0] == 'C' &&
        text[4] == 'e' && text[10] == '\0';
}
