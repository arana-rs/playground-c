#ifdef PRIVATE_VALUE
#error macro state leaked from another translation unit
#endif
int check_value(void) { return 2; }