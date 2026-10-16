
    struct Point { int x; int y; };
    struct Data { int values[3]; struct Point point; int flag; };
    int main(void) {
      int matrix[2][2] = { 1, 2, 3, 4 };
      struct Data data = { .point = { .y = 7, .x = 3 }, .values = { [2] = 9, [0] = 5 } };
      return matrix[1][1] == 4 && data.values[0] == 5 && data.values[1] == 0 &&
        data.values[2] == 9 && data.point.x == 3 && data.point.y == 7 && data.flag == 0;
    }
  