#include <stdint.h>
#include <math.h>
long factorial(int n) { if (n <= 1) return 1; return n * factorial(n - 1); }
int main(void) {
    uint64_t exact = 9007199254740993ULL;
    int sum = 0;
    for (int i = 1; i <= 6; ++i) sum += i;
    return exact - 9007199254740992ULL == 1 && factorial(10) == 3628800L && sqrt(81.0) == 9.0 && sum == 21;
}