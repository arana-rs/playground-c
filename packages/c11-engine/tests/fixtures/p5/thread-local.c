_Thread_local int shared_counter;
static _Thread_local int private_counter;

int next_shared(void) {
    return ++shared_counter;
}

int next_private(void) {
    return ++private_counter;
}

int main(void) {
    return next_shared() == 1 && next_shared() == 2 &&
        next_private() == 1 && next_private() == 2;
}
