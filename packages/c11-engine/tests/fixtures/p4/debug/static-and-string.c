static int file_count = 2;

int count_visit(void) {
    static int visits = 0;
    visits += 1;
    return visits;
}

int main(void) {
    int index = 0;
    int count = 0;
    while (index < 2) {
        count = count_visit();
        index += "x"[0] == 120 ? 1 : 0;
    }
    return file_count == 2 && count == 2 ? 0 : 1;
}

int never_called(void) {
    static int never_reached = 7;
    return never_reached;
}
