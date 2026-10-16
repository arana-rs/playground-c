
    int sum(int values[], int count) {
      int total = 0;
      for (int i = 0; i < count; ++i) total += values[i];
      return total;
    }
    int rows_sum(int rows[][2]) { return rows[0][0] + rows[0][1] + rows[1][0] + rows[1][1]; }
    int main(void) {
      int values[4] = { 1, 2, 3 };
      int rows[2][2] = { 1, 2, 3, 4 };
      return sum(values, 4) == 6 && values[3] == 0 && rows_sum(rows) == 10;
    }
  