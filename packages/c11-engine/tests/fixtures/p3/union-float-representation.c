int main(void) { 
    union Representation { unsigned int bits; float value; };
    union Representation value = { .bits = 0x3f800000U };
    return sizeof(value) == sizeof(float) && value.value == 1.0f;
   }