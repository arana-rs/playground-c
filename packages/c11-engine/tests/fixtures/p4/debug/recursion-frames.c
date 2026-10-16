int descend(int remaining) {
    int saved = remaining;
    if (remaining == 0) return saved;
    return saved + descend(remaining - 1);
}

int main(void) {
    int answer = descend(3);
    return answer == 6 ? 0 : 1;
}
