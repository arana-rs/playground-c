
    enum State { START, READY = 4, DONE };
    int main(void) {
      int matrix[2][2] = { 1, 2, 3, 4 };
      enum State state = DONE;
      switch (state) {
        case START: return 0;
        case READY: return 0;
        case DONE: return matrix[0][0] == 1 && matrix[0][1] == 2 &&
          matrix[1][0] == 3 && matrix[1][1] == 4;
        default: return 0;
      }
    }
  