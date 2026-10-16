struct Point {
    short x;
    int y;
};

union Choice {
    int code;
    char bytes[3];
};

struct S {
    int first;
    char tag;
    int *link;
    int value;
    int values[2];
    struct Point nested;
    union Choice choice;
    char tail;
};

union RootChoice {
    int integer;
    double ratio;
};

struct Wide {
    int f0;
    int f1;
    int f2;
    int f3;
    int f4;
    int f5;
    int f6;
    int f7;
    int f8;
    int f9;
    int f10;
};

int main(void) {
    int target = 41;
    struct S s;
    int *first = &s.first;
    struct S *root = &s;
    s.first = 5;
    s.tag = 'S';
    s.link = &target;
    s.value = 7;
    root->value = 9;
    s.link = &s.first;
    union RootChoice whole_union;
    struct Wide too_many;
    return 0;
}
