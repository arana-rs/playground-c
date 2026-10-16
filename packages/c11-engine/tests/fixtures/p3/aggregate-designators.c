int main(void) { 
    struct Point { int x; int y; };
    struct Board { int cells[4]; struct Point origin; int flag; };
    struct Board board = {
      .origin = { .y = 7, .x = 3 },
      .cells = { [3] = 9, [1] = 4 },
    };
    struct Point empty = { 0 };
    return board.cells[0] == 0 && board.cells[1] == 4 &&
      board.cells[2] == 0 && board.cells[3] == 9 &&
      board.origin.x == 3 && board.origin.y == 7 && board.flag == 0 &&
      empty.x == 0 && empty.y == 0;
   }