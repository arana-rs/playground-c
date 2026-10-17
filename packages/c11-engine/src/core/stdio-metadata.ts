/** One profile-owned list for stdio.h declarations and public capabilities. */
export const STDIO_FUNCTIONS: readonly string[] = Object.freeze([
  'remove', 'rename', 'tmpfile', 'tmpnam',
  'fclose', 'fflush', 'fopen', 'freopen', 'setbuf', 'setvbuf',
  'fprintf', 'fscanf', 'printf', 'scanf', 'vfprintf', 'vfscanf', 'vprintf', 'vscanf',
  'fgetc', 'fgets', 'fputc', 'fputs', 'getc', 'getchar', 'putc', 'putchar', 'puts', 'ungetc',
  'fread', 'fwrite',
  'fgetpos', 'fseek', 'fsetpos', 'ftell', 'rewind',
  'clearerr', 'feof', 'ferror', 'perror',
  'sprintf', 'snprintf', 'sscanf', 'vsprintf', 'vsnprintf', 'vsscanf',
]);

export const STDIO_CONSTANTS: Readonly<Record<string, string>> = Object.freeze({
  EOF: '(-1)',
  BUFSIZ: '4096',
  FOPEN_MAX: '16',
  FILENAME_MAX: '4096',
  L_tmpnam: '25',
  TMP_MAX: '10000',
  SEEK_SET: '0',
  SEEK_CUR: '1',
  SEEK_END: '2',
  _IOFBF: '0',
  _IOLBF: '1',
  _IONBF: '2',
});

export const STDIO_MACROS: readonly string[] = Object.freeze([
  ...Object.keys(STDIO_CONSTANTS), 'stdin', 'stdout', 'stderr',
]);

/** C11 narrow stdio declarations for the VM profile; wide declarations stay unplanned. */
export const STDIO_HEADER_BODY = `
#include <stddef.h>
#include <stdarg.h>
typedef struct __c11_FILE FILE;
typedef long fpos_t;
${Object.entries(STDIO_CONSTANTS).map(([name, value]) => `#define ${name} ${value}`).join('\n')}
FILE *__c11_stdin(void);
FILE *__c11_stdout(void);
FILE *__c11_stderr(void);
#define stdin (__c11_stdin())
#define stdout (__c11_stdout())
#define stderr (__c11_stderr())
int remove(const char *);
int rename(const char *, const char *);
FILE *tmpfile(void);
char *tmpnam(char *);
int fclose(FILE *);
int fflush(FILE *);
FILE *fopen(const char * restrict, const char * restrict);
FILE *freopen(const char * restrict, const char * restrict, FILE * restrict);
void setbuf(FILE * restrict, char * restrict);
int setvbuf(FILE * restrict, char * restrict, int, size_t);
int fprintf(FILE * restrict, const char * restrict, ...);
int fscanf(FILE * restrict, const char * restrict, ...);
int printf(const char * restrict, ...);
int scanf(const char * restrict, ...);
int vfprintf(FILE * restrict, const char * restrict, va_list);
int vfscanf(FILE * restrict, const char * restrict, va_list);
int vprintf(const char * restrict, va_list);
int vscanf(const char * restrict, va_list);
int fgetc(FILE *);
char *fgets(char * restrict, int, FILE * restrict);
int fputc(int, FILE *);
int fputs(const char * restrict, FILE * restrict);
int getc(FILE *);
int getchar(void);
int putc(int, FILE *);
int putchar(int);
int puts(const char *);
int ungetc(int, FILE *);
size_t fread(void * restrict, size_t, size_t, FILE * restrict);
size_t fwrite(const void * restrict, size_t, size_t, FILE * restrict);
int fgetpos(FILE * restrict, fpos_t * restrict);
int fseek(FILE *, long, int);
int fsetpos(FILE *, const fpos_t *);
long ftell(FILE *);
void rewind(FILE *);
void clearerr(FILE *);
int feof(FILE *);
int ferror(FILE *);
void perror(const char *);
int sprintf(char * restrict, const char * restrict, ...);
int snprintf(char * restrict, size_t, const char * restrict, ...);
int sscanf(const char * restrict, const char * restrict, ...);
int vsprintf(char * restrict, const char * restrict, va_list);
int vsnprintf(char * restrict, size_t, const char * restrict, va_list);
int vsscanf(const char * restrict, const char * restrict, va_list);
`;
