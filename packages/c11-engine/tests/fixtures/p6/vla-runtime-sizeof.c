#include <stddef.h>

static int bound_evaluations;

static int counted_bound(int value)
{
    ++bound_evaluations;
    return value;
}

static int row_bytes(int rows, int columns, int matrix[rows][columns])
{
    (void)rows;
    if (sizeof matrix != sizeof(int *)) return 0;
    if (sizeof matrix[0] != (size_t)columns * sizeof(int)) return 0;
    if (sizeof matrix[1] != (size_t)columns * sizeof(int)) return 0;
    return 1;
}

static int adjusted_parameter(int count, int values[count])
{
    (void)count;
    (void)values;
    return sizeof values == sizeof(int *);
}

int main(void)
{
    int length = 3;
    int values[counted_bound(length)];
    if (bound_evaluations != 1) return 0;
    if (sizeof values != 3 * sizeof(int)) return 0;

    length = 7;
    if (sizeof values != 3 * sizeof(int)) return 0;
    if (bound_evaluations != 1) return 0;

    size_t type_name_size = sizeof(int[counted_bound(length)]);
    if (type_name_size != 7 * sizeof(int)) return 0;
    if (bound_evaluations != 2) return 0;

    typedef int CapturedRow[counted_bound(length)];
    if (bound_evaluations != 3) return 0;
    length = 9;
    CapturedRow rows[2];
    if (sizeof rows != 14 * sizeof(int)) return 0;
    if (sizeof rows[0] != 7 * sizeof(int)) return 0;
    if (bound_evaluations != 3) return 0;

    int row_count = 2;
    int column_count = 4;
    int matrix[row_count][column_count];
    if (sizeof matrix != 8 * sizeof(int)) return 0;
    if (sizeof matrix[0] != 4 * sizeof(int)) return 0;
    if (sizeof matrix[0][0] != sizeof(int)) return 0;
    if (!row_bytes(row_count, column_count, matrix)) return 0;
    if (!adjusted_parameter(3, values)) return 0;

    for (int bound = 1; bound <= 4; ++bound) {
        int evaluations_before = bound_evaluations;
        int iteration[ counted_bound(bound) ];
        if (bound_evaluations != evaluations_before + 1) return 0;
        if (sizeof iteration != (size_t)bound * sizeof(int)) return 0;
        if (bound_evaluations != evaluations_before + 1) return 0;
    }

    return 1;
}
