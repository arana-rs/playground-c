
    enum State { START, READY = 4, DONE };
    int main(void) {
      enum State state = DONE;
      switch (state) {
        case START: return 0;
        case READY: return 0;
        case DONE: return state == 5;
      }
      return 0;
    }
  