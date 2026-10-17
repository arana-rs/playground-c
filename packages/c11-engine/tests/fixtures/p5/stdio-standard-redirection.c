#include <errno.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  if (setvbuf(stdout, 0, _IONBF, 0) != 0) return 1;
  if (setvbuf(stdout, 0, _IOFBF, BUFSIZ) == 0) return 2;
  if (setvbuf(stdout, 0, _IOLBF, BUFSIZ) == 0) return 3;
  setbuf(stdout, 0);

  FILE *input = freopen("stdin.dat", "r", stdin);
  if (input != stdin || getchar() != '4') return 4;
  int value = 0;
  if (scanf("%d", &value) != 1 || value != 2) return 5;
  if (fclose(stdin) != 0 || getchar() != EOF) return 6;
  if (freopen("stdin.dat", "r", stdin) != stdin || getchar() != '4') return 7;

  if (freopen("stdout.dat", "w", stdout) != stdout) return 8;
  if (printf("redirected") != 10 || fclose(stdout) != 0) return 9;
  if (puts("closed") != EOF) return 10;
  if (freopen("recovered.dat", "w", stdout) != stdout || printf("ok") != 2) return 11;
  if (fclose(stdout) != 0) return 12;

  if (freopen("stderr.dat", "w", stderr) != stderr) return 13;
  errno = EILSEQ;
  perror(0);
  if (fclose(stderr) != 0) return 14;

  FILE *file = fopen("stdout.dat", "r");
  char output[11] = {0};
  if (!file || fread(output, 1, 10, file) != 10 || strcmp(output, "redirected")) return 15;
  fclose(file);
  file = fopen("recovered.dat", "r");
  char recovered[3] = {0};
  if (!file || fread(recovered, 1, 2, file) != 2 || strcmp(recovered, "ok")) return 16;
  fclose(file);
  file = fopen("stderr.dat", "r");
  char error[32] = {0};
  if (!file || !fgets(error, sizeof error, file) || strcmp(error, "Illegal byte sequence\n")) return 17;
  fclose(file);
  return 0;
}
