int main(void) {
    int a[3] = {10, 20, 30};
    int *p = &a[0];
    p++;
    *p = 99;

    char text[] = "code";
    char *q = text;
    q++;
    q++;
    q++;
    q++;
    return 0;
}
