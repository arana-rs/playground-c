struct Flags {
    unsigned int first : 3;
    unsigned int second : 5;
    unsigned int third : 6;
    unsigned int : 0;
    unsigned int last : 2;
};

struct SignedFlags {
    signed int value : 4;
};

int main(void) {
    struct Flags flags = { 0 };
    struct SignedFlags signed_flags = { 0 };
    unsigned char *representation = (unsigned char *)&flags;
    flags.first = 5;
    flags.second = 17;
    flags.third = 33;
    flags.last = 2;
    signed_flags.value = -8;
    return sizeof(struct Flags) == 8 && _Alignof(struct Flags) == 4 &&
        flags.first == 5 && flags.second == 17 && flags.third == 33 &&
        flags.last == 2 && signed_flags.value == -8 &&
        representation[0] == 0x8d && (representation[1] & 0x3f) == 0x21 &&
        (representation[4] & 0x03) == 0x02;
}
