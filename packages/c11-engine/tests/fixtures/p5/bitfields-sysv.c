struct CharThenBit {
    char lead;
    unsigned int flag : 1;
};

struct ZeroWidthBarrier {
    char lead;
    unsigned int : 0;
    char tail;
};

struct MixedBitfieldTypes {
    unsigned short first : 7;
    unsigned int second : 7;
};

struct CrossUnit {
    unsigned int first : 31;
    unsigned int second : 2;
};

union OverlappingBitfields {
    unsigned int all;
    struct {
        unsigned int low : 4;
        unsigned int high : 4;
    } parts;
};

struct PlainIntBitfield {
    int value : 3;
};

int main(void) {
    struct CharThenBit after_char = { 0 };
    struct ZeroWidthBarrier barrier = { 0 };
    struct MixedBitfieldTypes mixed = { 0 };
    struct CrossUnit cross = { 0 };
    union OverlappingBitfields overlapping = { 0 };
    struct PlainIntBitfield plain = { 0 };
    unsigned char *after_char_bytes = (unsigned char *)&after_char;
    unsigned char *mixed_bytes = (unsigned char *)&mixed;
    unsigned char *cross_bytes = (unsigned char *)&cross;

    after_char.flag = 1;
    barrier.tail = 0x55;
    mixed.first = 0x55;
    mixed.second = 0x2a;
    cross.first = 0x55555555U;
    cross.second = 3;
    overlapping.parts.low = 0xa;
    overlapping.parts.high = 5;
    plain.value = -1;

    return sizeof after_char == 4 && _Alignof(struct CharThenBit) == 4 &&
        after_char_bytes[1] == 1 &&
        sizeof barrier == 5 && _Alignof(struct ZeroWidthBarrier) == 1 &&
        (unsigned long)((char *)&barrier.tail - (char *)&barrier) == 4 &&
        sizeof mixed == 4 && _Alignof(struct MixedBitfieldTypes) == 4 &&
        mixed_bytes[0] == 0x55 && mixed_bytes[1] == 0x15 &&
        sizeof cross == 8 && cross_bytes[4] == 3 &&
        sizeof overlapping == 4 && overlapping.all == 0x5a &&
        plain.value == -1 && (((unsigned char *)&plain)[0] & 0x07) == 0x07;
}
