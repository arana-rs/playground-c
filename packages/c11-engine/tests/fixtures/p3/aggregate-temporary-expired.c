
    struct Sample { int values[1]; };
    struct Sample make_sample(void) { struct Sample sample = { { 42 } }; return sample; }
    int main(void) { int *saved = make_sample().values; return *saved; }
  