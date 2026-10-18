#include <stddef.h>

int main(void)
{
    int row_count = 2;
    int column_count = 3;
    int matrix[row_count][column_count];
    int (*row)[column_count] = matrix;
    int (*first_row)[column_count] = row;

    if (sizeof *row != 3 * sizeof(int)) return 0;
    if (row + 1 != &matrix[1]) return 0;

    size_t row_bytes = sizeof *(row++);
    if (row_bytes != 3 * sizeof(int)) return 0;
    if (row != first_row + 1) return 0;

    return 1;
}
