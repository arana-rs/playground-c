import { HEAP_ALLOCATOR_BUILTINS, HEAP_ALLOCATOR_SIGNATURES } from './allocator-builtins.ts';

/** The exposed C11 narrow stdlib surface for the deterministic VM profile. */
export const STDLIB_FUNCTIONS: readonly string[] = Object.freeze([
  'atof', 'atoi', 'atol', 'atoll', 'strtod', 'strtof', 'strtold',
  'strtol', 'strtoul', 'strtoll', 'strtoull',
  'rand', 'srand', 'abort', 'atexit', 'at_quick_exit', 'exit', '_Exit', 'quick_exit',
  'getenv', 'system', 'bsearch', 'qsort', 'abs', 'labs', 'llabs', 'div', 'ldiv', 'lldiv',
  ...HEAP_ALLOCATOR_BUILTINS, 'calloc', 'free', 'aligned_alloc', 'mblen',
]);

export const STDLIB_CONSTANTS: Readonly<Record<string, string>> = Object.freeze({
  EXIT_FAILURE: '1',
  EXIT_SUCCESS: '0',
  RAND_MAX: '2147483647',
  MB_CUR_MAX: '1',
});

export const STDLIB_MACROS: readonly string[] = Object.freeze(Object.keys(STDLIB_CONSTANTS));

export const STDLIB_HEADER_BODY = `
#include <stddef.h>
#include <stdint.h>
typedef struct { int quot; int rem; } div_t;
typedef struct { long quot; long rem; } ldiv_t;
typedef struct { long long quot; long long rem; } lldiv_t;
${Object.entries(STDLIB_CONSTANTS).map(([name, value]) => `#define ${name} ${value}`).join('\n')}
double atof(const char *);
int atoi(const char *);
long atol(const char *);
long long atoll(const char *);
double strtod(const char * restrict, char ** restrict);
float strtof(const char * restrict, char ** restrict);
long double strtold(const char * restrict, char ** restrict);
long strtol(const char * restrict, char ** restrict, int);
unsigned long strtoul(const char * restrict, char ** restrict, int);
long long strtoll(const char * restrict, char ** restrict, int);
unsigned long long strtoull(const char * restrict, char ** restrict, int);
int rand(void);
void srand(unsigned int);
void abort(void);
int atexit(void (*)(void));
int at_quick_exit(void (*)(void));
void exit(int);
void _Exit(int);
void quick_exit(int);
char *getenv(const char *);
int system(const char *);
void *bsearch(const void *, const void *, size_t, size_t, int (*)(const void *, const void *));
void qsort(void *, size_t, size_t, int (*)(const void *, const void *));
int abs(int);
long labs(long);
long long llabs(long long);
div_t div(int, int);
ldiv_t ldiv(long, long);
lldiv_t lldiv(long long, long long);
${HEAP_ALLOCATOR_SIGNATURES.malloc.prototype}
void *calloc(size_t, size_t);
${HEAP_ALLOCATOR_SIGNATURES.realloc.prototype}
void free(void *);
void *aligned_alloc(size_t, size_t);
int mblen(const char *, size_t);
`;

/** C11 UTC-profile time API; no host clock or timezone functions are exposed. */
export const TIME_FUNCTIONS: readonly string[] = Object.freeze([
  'clock', 'difftime', 'mktime', 'time', 'asctime', 'ctime', 'gmtime', 'localtime', 'strftime', 'timespec_get',
]);

export const TIME_CONSTANTS: Readonly<Record<string, string>> = Object.freeze({
  CLOCKS_PER_SEC: '1000000L',
  TIME_UTC: '1',
});

export const TIME_MACROS: readonly string[] = Object.freeze(Object.keys(TIME_CONSTANTS));

export const TIME_HEADER_BODY = `
#include <stddef.h>
typedef long clock_t;
typedef long time_t;
struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
};
struct timespec { time_t tv_sec; long tv_nsec; };
${Object.entries(TIME_CONSTANTS).map(([name, value]) => `#define ${name} ${value}`).join('\n')}
clock_t clock(void);
double difftime(time_t, time_t);
time_t mktime(struct tm *);
time_t time(time_t *);
char *asctime(const struct tm *);
char *ctime(const time_t *);
struct tm *gmtime(const time_t *);
struct tm *localtime(const time_t *);
size_t strftime(char * restrict, size_t, const char * restrict, const struct tm * restrict);
int timespec_get(struct timespec *, int);
`;
