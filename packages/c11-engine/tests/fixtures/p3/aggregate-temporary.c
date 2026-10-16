
    struct Sample { int values[1]; };
    struct Sample make_sample(void) { struct Sample sample = { { 42 } }; return sample; }
    int main(void) { return make_sample().values[0] == 42; }
  