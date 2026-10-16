
    struct Sample { int values[1]; };
    struct Sample make_sample(void) { struct Sample sample = { { 42 } }; return sample; }
    int main(void) {
      int first = make_sample().values[0];
      int second = make_sample().values[0];
      return first + second == 84;
    }
  