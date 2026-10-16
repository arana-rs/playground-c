int main(void) { unsigned long long a = 9007199254740993ULL; unsigned long long b = 9007199254740992ULL;
    return a != b && a - b == 1ULL && a + 2ULL == 9007199254740995ULL &&
      a / 3ULL == 3002399751580331ULL && a % 3ULL == 0ULL; }