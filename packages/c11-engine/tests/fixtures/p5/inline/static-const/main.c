int next_value(void);
int const_array_value(void);

int main(void) {
    return next_value() == 7 && const_array_value() == 3;
}
