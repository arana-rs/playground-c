
    int sum(int values[], int count) {
      int total = 0;
      for (int index = 0; index < count; ++index) total += values[index];
      return sizeof(values) == sizeof(int *) ? total : -1;
    }
    int matrix_sum(int rows[][2]) {
      return sizeof(rows) == sizeof(int *)
        ? rows[0][0] + rows[0][1] + rows[1][0] + rows[1][1]
        : -1;
    }
    int main(void) {
      int values[4] = { 10, 20, 12 };
      int matrix[2][2] = { 1, 2, 3, 4 };
      char text[] = "C11";
      char *literal = "C11";
      text[1] = '8';
      return sizeof(values) == 16 && values[3] == 0 && sum(values, 4) == 42 &&
        sizeof(matrix) == 16 && sizeof(matrix[0]) == 8 && matrix_sum(matrix) == 10 &&
        sizeof(text) == 4 && text[1] == '8' && text[3] == '\0' &&
        sizeof("C11") == 4 && literal[3] == '\0';
    }
  