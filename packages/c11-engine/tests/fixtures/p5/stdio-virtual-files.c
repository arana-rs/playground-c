#include <errno.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  FILE *exclusive = fopen("exclusive.dat", "wx");
  if (!exclusive) return 1;
  errno = 0;
  if (fopen("exclusive.dat", "wx") != 0 || errno != EEXIST) return 2;
  if (fputs("abc", exclusive) == EOF) return 3;
  errno = 0;
  if (remove("exclusive.dat") != -1 || errno != EBUSY) return 4;
  if (fclose(exclusive) != 0) return 5;
  if (rename("exclusive.dat", "renamed.dat") != 0) return 6;

  FILE *stream = fopen("renamed.dat", "rb");
  if (!stream) return 7;
  char bytes[4] = {0};
  if (fread(bytes, 1, 3, stream) != 3 || memcmp(bytes, "abc", 3)) return 8;
  if (fseek(stream, 0, SEEK_SET) != 0 || fgetc(stream) != 'a') return 9;
  if (ungetc('X', stream) != 'X') return 10;
  fpos_t position;
  if (fgetpos(stream, &position) != 0 || fgetc(stream) != 'X') return 11;
  if (fsetpos(stream, &position) != 0 || fgetc(stream) != 'a') return 12;
  if (fclose(stream) != 0 || remove("renamed.dat") != 0) return 13;

  FILE *temporary = tmpfile();
  if (!temporary || fwrite("tmp", 1, 3, temporary) != 3) return 14;
  rewind(temporary);
  if (fgetc(temporary) != 't' || fclose(temporary) != 0) return 15;

  char saved[L_tmpnam], supplied[L_tmpnam];
  char *first = tmpnam(0);
  if (!first || strlen(first) >= L_tmpnam) return 16;
  strcpy(saved, first);
  char *second = tmpnam(0);
  if (first != second || strcmp(saved, second) == 0) return 17;
  if (tmpnam(supplied) != supplied || strcmp(supplied, second) == 0) return 18;

  if (remove("missing.dat") != -1 || errno != ENOENT) return 19;
  return 0;
}
