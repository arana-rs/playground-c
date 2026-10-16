int main(void) { 
    int values[4] = { 3, 5, 7, 11 };
    int *begin = values;
    int *middle = begin + 2;
    int *end = begin + 4;
    void *opaque = (void *)middle;
    int *alias = (int *)opaque;
    int *null_pointer = 0;
    void *null_object = null_pointer;
    *alias += 1;
    return sizeof(begin) == 8 && alias == middle && *middle == 8 &&
      end == values + 4 && end - begin == 4 && middle - begin == 2 &&
      begin[1] == 5 && null_pointer == 0 && null_object == 0;
   }