#define SET_PRAGMA(value) _Pragma(#value)

#pragma STDC FP_CONTRACT OFF
SET_PRAGMA(STDC FENV_ACCESS OFF)

int main(void) {
    return 40 + 2 == 42;
}
