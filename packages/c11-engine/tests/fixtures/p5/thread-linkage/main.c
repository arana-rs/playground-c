extern _Thread_local int value;

int main(void) {
    return value == 7;
}
