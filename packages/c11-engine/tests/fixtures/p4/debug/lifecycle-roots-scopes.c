struct Cell {
    int code;
    int coordinates[2];
};

static struct Cell global_cell = { 7, { 8, 9 } };

int main(void) {
    int result = global_cell.code;
    {
        struct Cell local_cell = { 1, { 2, 3 } };
        int samples[3] = { 4, 5, 6 };
        struct Cell *temporary = &(struct Cell){ 7, { 8, 9 } };
        result += local_cell.coordinates[0] + samples[2] + temporary->code;
    }
    return result == 22 ? 0 : 1;
}
