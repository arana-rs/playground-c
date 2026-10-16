int main(void) {
    int count = 0;
    while (count < 3) { count++; }
    int goto_count = 0; again: goto_count++; if (goto_count < 2) goto again;
    return 0;
}
