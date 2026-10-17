extern int values[];
int array_size(void);

int main(void) {
    return values[0] == 4 && values[1] == 9 && array_size() == 8;
}
