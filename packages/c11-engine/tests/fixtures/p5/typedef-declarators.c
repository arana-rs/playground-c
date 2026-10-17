typedef unsigned long Count;
typedef int Transform(int);
typedef Transform *TransformPointer;
typedef int Row[3];

int increment(int value) { return value + 1; }

int apply(TransformPointer transform, int value) { return transform(value); }

int main(void) {
    Count count = 2;
    Row values = { 4, 6, 8 };
    TransformPointer transform = increment;
    int (*matrix)[3] = &values;
    return count == 2 && (*matrix)[1] == 6 && apply(transform, 4) == 5;
}
