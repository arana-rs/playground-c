int main(void) {
    int a[4] = {10, 20};
    int uninitialized[3];
    uninitialized[1] = 7;
    a[0]++;
    a[1] = a[1] + 1;

    char text[5] = "code";
    char raw[3] = "abc";
    char large[] = "abcdefghij";
    int matrix[2][2] = {{1, 2}, {3, 4}};
    return 0;
}
