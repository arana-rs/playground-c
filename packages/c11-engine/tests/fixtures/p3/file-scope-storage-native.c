
    int visits = 8;
    static int totals[2];
    int bump(void) { ++visits; totals[1] += 2; return visits; }
    int main(void) {
      int value = bump();
      return value == 9 && totals[0] == 0 && totals[1] == 2;
    }
  