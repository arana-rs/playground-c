import { HEAP_ALLOCATOR_BUILTINS, HEAP_ALLOCATOR_SIGNATURES } from './allocator-builtins.ts';

const guarded = (name: string, body: string): string => {
  const guard = `__C11_VIRTUAL_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return `#ifndef ${guard}\n#define ${guard} 1\n${body.trim()}\n#endif\n`;
};

const limitsMacros: Record<string, string> = {
  CHAR_BIT: '8', SCHAR_MIN: '(-127-1)', SCHAR_MAX: '127', UCHAR_MAX: '255', CHAR_MIN: '(-127-1)', CHAR_MAX: '127',
  SHRT_MIN: '(-32767-1)', SHRT_MAX: '32767', USHRT_MAX: '65535', INT_MIN: '(-2147483647-1)', INT_MAX: '2147483647', UINT_MAX: '4294967295U',
  LONG_MIN: '(-9223372036854775807L-1L)', LONG_MAX: '9223372036854775807L', ULONG_MAX: '18446744073709551615UL',
  LLONG_MIN: '(-9223372036854775807LL-1LL)', LLONG_MAX: '9223372036854775807LL', ULLONG_MAX: '18446744073709551615ULL',
};

const floatMacros: Record<string, string> = {
  FLT_RADIX: '2', FLT_ROUNDS: '1', FLT_EVAL_METHOD: '0', DECIMAL_DIG: '21',
  FLT_MANT_DIG: '24', FLT_DIG: '6', FLT_DECIMAL_DIG: '9', FLT_MIN_EXP: '(-125)', FLT_MAX_EXP: '128', FLT_MIN_10_EXP: '(-37)', FLT_MAX_10_EXP: '38',
  FLT_EPSILON: '0x1p-23F', FLT_MIN: '0x1p-126F', FLT_MAX: '0x1.fffffep127F', FLT_TRUE_MIN: '0x1p-149F', FLT_HAS_SUBNORM: '1',
  DBL_MANT_DIG: '53', DBL_DIG: '15', DBL_DECIMAL_DIG: '17', DBL_MIN_EXP: '(-1021)', DBL_MAX_EXP: '1024', DBL_MIN_10_EXP: '(-307)', DBL_MAX_10_EXP: '308',
  DBL_EPSILON: '0x1p-52', DBL_MIN: '0x1p-1022', DBL_MAX: '0x1.fffffffffffffp1023', DBL_TRUE_MIN: '0x1p-1074', DBL_HAS_SUBNORM: '1',
  LDBL_MANT_DIG: '64', LDBL_DIG: '18', LDBL_DECIMAL_DIG: '21', LDBL_MIN_EXP: '(-16381)', LDBL_MAX_EXP: '16384', LDBL_MIN_10_EXP: '(-4931)', LDBL_MAX_10_EXP: '4932',
  LDBL_EPSILON: '0x1p-63L', LDBL_MIN: '0x1p-16382L', LDBL_MAX: '0x1.ffffffffffffffffp16383L', LDBL_TRUE_MIN: '0x1p-16445L', LDBL_HAS_SUBNORM: '1',
};

const integerTypes: Record<string, string> = {};
const integerMacros: Record<string, string> = {};
for (const [width, signed, unsigned, max, suffix] of [
  [8, 'signed char', 'unsigned char', '127', ''], [16, 'short', 'unsigned short', '32767', ''],
  [32, 'int', 'unsigned int', '2147483647', ''], [64, 'long', 'unsigned long', '9223372036854775807', 'L'],
] as const) {
  const unsignedMax = width === 64 ? '18446744073709551615UL' : width === 32 ? '4294967295U' : width === 16 ? '65535' : '255';
  for (const family of ['', '_least', '_fast']) {
    const fastLong = family === '_fast' && (width === 16 || width === 32);
    const base = `INT${family.toUpperCase()}${width}`;
    integerTypes[`int${family}${width}_t`] = fastLong ? 'long' : signed;
    integerTypes[`uint${family}${width}_t`] = fastLong ? 'unsigned long' : unsigned;
    integerMacros[`${base}_MAX`] = fastLong ? limitsMacros.LONG_MAX : `${max}${suffix}`;
    integerMacros[`${base}_MIN`] = `(-${integerMacros[`${base}_MAX`]}-1${fastLong ? 'L' : suffix})`;
    integerMacros[`U${base}_MAX`] = fastLong ? limitsMacros.ULONG_MAX : unsignedMax;
  }
}
Object.assign(integerTypes, {
  intmax_t: 'long', uintmax_t: 'unsigned long', intptr_t: 'long', uintptr_t: 'unsigned long',
});
Object.assign(integerMacros, {
  INTMAX_MIN: limitsMacros.LONG_MIN, INTMAX_MAX: limitsMacros.LONG_MAX, UINTMAX_MAX: limitsMacros.ULONG_MAX,
  INTPTR_MIN: limitsMacros.LONG_MIN, INTPTR_MAX: limitsMacros.LONG_MAX, UINTPTR_MAX: limitsMacros.ULONG_MAX,
  PTRDIFF_MIN: limitsMacros.LONG_MIN, PTRDIFF_MAX: limitsMacros.LONG_MAX, SIZE_MAX: limitsMacros.ULONG_MAX,
});

const ctypeFunctions = [
  'isalnum', 'isalpha', 'isblank', 'iscntrl', 'isdigit', 'isgraph', 'islower', 'isprint', 'ispunct', 'isspace', 'isupper', 'isxdigit', 'tolower', 'toupper',
];
const stringFunctions = [
  'memcpy', 'memmove', 'memset', 'memcmp', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp', 'strchr', 'strrchr', 'strspn', 'strcspn', 'strpbrk', 'strstr', 'strtok', 'strlen', 'strerror',
];
const stdioFunctions = [
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf', 'fopen', 'fclose', 'fflush', 'fgetc', 'getc', 'getchar', 'fgets', 'fputc', 'putc', 'putchar', 'fputs', 'puts',
  'fread', 'fwrite', 'fseek', 'ftell', 'rewind', 'ungetc', 'feof', 'ferror', 'clearerr', 'perror',
];
const inttypesFunctions = ['imaxabs', 'imaxdiv', 'strtoimax', 'strtoumax'];
const inttypesFormatFamilies = [
  ...[8, 16, 32, 64].flatMap((width) => [
    { suffix: String(width), signed: `int${width}_t`, unsigned: `uint${width}_t` },
    { suffix: `LEAST${width}`, signed: `int_least${width}_t`, unsigned: `uint_least${width}_t` },
    { suffix: `FAST${width}`, signed: `int_fast${width}_t`, unsigned: `uint_fast${width}_t` },
  ]),
  { suffix: 'MAX', signed: 'intmax_t', unsigned: 'uintmax_t' },
  { suffix: 'PTR', signed: 'intptr_t', unsigned: 'uintptr_t' },
];
const printfLength = (name: string): string => name.includes('long long') ? 'll' : name.includes('long') ? 'l' : '';
const scanfLength = (name: string): string => name.includes('long long') ? 'll' : name.includes('long') ? 'l' : name === 'short' || name === 'unsigned short' ? 'h' : name === 'signed char' || name === 'unsigned char' ? 'hh' : '';
const inttypesFormatMacros = inttypesFormatFamilies.flatMap(({ suffix, signed, unsigned }) => {
  const signedType = integerTypes[signed];
  const unsignedType = integerTypes[unsigned];
  const printfSignedLength = printfLength(signedType);
  const printfUnsignedLength = printfLength(unsignedType);
  const scanfSignedLength = scanfLength(signedType);
  const scanfUnsignedLength = scanfLength(unsignedType);
  return [
    ...['d', 'i'].map((conversion) => `#define PRI${conversion}${suffix} "${printfSignedLength}${conversion}"`),
    ...['o', 'u', 'x', 'X'].map((conversion) => `#define PRI${conversion}${suffix} "${printfUnsignedLength}${conversion}"`),
    ...['d', 'i'].map((conversion) => `#define SCN${conversion}${suffix} "${scanfSignedLength}${conversion}"`),
    ...['o', 'u', 'x'].map((conversion) => `#define SCN${conversion}${suffix} "${scanfUnsignedLength}${conversion}"`),
  ];
});

/** Standard functions declared by each source-backed virtual header. */
export const LIBRARY_DECLARATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'assert.h': Object.freeze([]),
  'ctype.h': Object.freeze(ctypeFunctions),
  'errno.h': Object.freeze([]),
  'float.h': Object.freeze([]),
  'inttypes.h': Object.freeze(inttypesFunctions),
  'iso646.h': Object.freeze([]),
  'limits.h': Object.freeze([]),
  'math.h': Object.freeze([]),
  'stdarg.h': Object.freeze([]),
  'stdbool.h': Object.freeze([]),
  'stddef.h': Object.freeze([]),
  'stdint.h': Object.freeze([]),
  'stdio.h': Object.freeze(stdioFunctions),
  'wchar.h': Object.freeze([]),
  'stdlib.h': Object.freeze([...HEAP_ALLOCATOR_BUILTINS, 'free']),
  'string.h': Object.freeze(stringFunctions),
});
export const LIBRARY_FUNCTIONS: readonly string[] = Object.freeze([
  ...new Set(Object.values(LIBRARY_DECLARATIONS).flat()),
  '__c11_assert_fail', '__c11_errno_location', '__c11_stdin', '__c11_stdout', '__c11_stderr',
]);

const stdintBody = [
  ...Object.entries(integerTypes).map(([name, type]) => `typedef ${type} ${name};`),
  ...Object.entries(integerMacros).map(([name, value]) => `#define ${name} ${value}`),
  '#define INT8_C(value) value', '#define UINT8_C(value) value',
  '#define INT16_C(value) value', '#define UINT16_C(value) value',
  '#define INT32_C(value) value', '#define UINT32_C(value) value##U',
  '#define INT64_C(value) value##L', '#define UINT64_C(value) value##UL',
  '#define INTMAX_C(value) value##L', '#define UINTMAX_C(value) value##UL',
  '#define __STDC_LIMIT_MACROS 1',
].join('\n');

const stdargBody = `
typedef void *__c11_va_list;
typedef __c11_va_list va_list;
#define va_start(ap, last) __builtin_va_start(&(ap), &(last))
#define va_arg(ap, type) __builtin_va_arg((ap), type)
#define va_copy(destination, source) __builtin_va_copy(&(destination), (source))
#define va_end(ap) __builtin_va_end(&(ap))
`;

const stdioBody = `
#include <stddef.h>
#include <stdarg.h>
typedef struct __c11_FILE FILE;
typedef long fpos_t;
#define EOF (-1)
#define BUFSIZ 4096
#define FOPEN_MAX 16
#define FILENAME_MAX 4096
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define _IOFBF 0
#define _IOLBF 1
#define _IONBF 2
FILE *__c11_stdin(void);
FILE *__c11_stdout(void);
FILE *__c11_stderr(void);
#define stdin (__c11_stdin())
#define stdout (__c11_stdout())
#define stderr (__c11_stderr())
int printf(const char * restrict, ...);
int fprintf(FILE * restrict, const char * restrict, ...);
int sprintf(char * restrict, const char * restrict, ...);
int snprintf(char * restrict, size_t, const char * restrict, ...);
int scanf(const char * restrict, ...);
int fscanf(FILE * restrict, const char * restrict, ...);
int sscanf(const char * restrict, const char * restrict, ...);
FILE *fopen(const char * restrict, const char * restrict);
int fclose(FILE *);
int fflush(FILE *);
int fgetc(FILE *);
int getc(FILE *);
int getchar(void);
char *fgets(char * restrict, int, FILE * restrict);
int fputc(int, FILE *);
int putc(int, FILE *);
int putchar(int);
int fputs(const char * restrict, FILE * restrict);
int puts(const char *);
size_t fread(void * restrict, size_t, size_t, FILE * restrict);
size_t fwrite(const void * restrict, size_t, size_t, FILE * restrict);
int fseek(FILE *, long, int);
long ftell(FILE *);
void rewind(FILE *);
int ungetc(int, FILE *);
int feof(FILE *);
int ferror(FILE *);
void clearerr(FILE *);
void perror(const char *);
`;

const stringBody = `
#include <stddef.h>
void *memcpy(void * restrict, const void * restrict, size_t);
void *memmove(void *, const void *, size_t);
void *memset(void *, int, size_t);
int memcmp(const void *, const void *, size_t);
char *strcpy(char * restrict, const char * restrict);
char *strncpy(char * restrict, const char * restrict, size_t);
char *strcat(char * restrict, const char * restrict);
char *strncat(char * restrict, const char * restrict, size_t);
int strcmp(const char *, const char *);
int strncmp(const char *, const char *, size_t);
char *strchr(const char *, int);
char *strrchr(const char *, int);
size_t strspn(const char *, const char *);
size_t strcspn(const char *, const char *);
char *strpbrk(const char *, const char *);
char *strstr(const char *, const char *);
char *strtok(char * restrict, const char * restrict);
size_t strlen(const char *);
char *strerror(int);
`;

const standardHeaders: Record<string, string> = {
  'assert.h': guarded('assert.h', `
#ifdef NDEBUG
#define assert(expression) ((void)0)
#else
void __c11_assert_fail(const char *, const char *, unsigned long);
#define assert(expression) ((expression) ? (void)0 : __c11_assert_fail(#expression, __FILE__, __LINE__))
#endif`),
  'ctype.h': guarded('ctype.h', ctypeFunctions.map((name) => `int ${name}(int);`).join('\n')),
  'errno.h': guarded('errno.h', `
extern int *__c11_errno_location(void);
#define errno (*__c11_errno_location())
#define EDOM 33
#define EILSEQ 84
#define ERANGE 34`),
  'float.h': guarded('float.h', Object.entries(floatMacros).map(([name, value]) => `#define ${name} ${value}`).join('\n')),
  'inttypes.h': guarded('inttypes.h', `
#include <stdint.h>
#include <stddef.h>
typedef struct { intmax_t quot; intmax_t rem; } imaxdiv_t;
${inttypesFormatMacros.join('\n')}
intmax_t imaxabs(intmax_t);
imaxdiv_t imaxdiv(intmax_t, intmax_t);
intmax_t strtoimax(const char * restrict, char ** restrict, int);
uintmax_t strtoumax(const char * restrict, char ** restrict, int);
`),
  'iso646.h': guarded('iso646.h', `
#define and &&
#define and_eq &=
#define bitand &
#define bitor |
#define compl ~
#define not !
#define not_eq !=
#define or ||
#define or_eq |=
#define xor ^
#define xor_eq ^=`),
  'limits.h': guarded('limits.h', Object.entries(limitsMacros).map(([name, value]) => `#define ${name} ${value}`).join('\n')),
  'math.h': guarded('math.h', `
float __c11_inf(void);
float __c11_nan(void);
#define INFINITY (__c11_inf())
#define HUGE_VAL ((double)__c11_inf())
#define HUGE_VALF (__c11_inf())
#define NAN (__c11_nan())
#define FP_NAN 0
#define FP_INFINITE 1
#define FP_ZERO 2
#define FP_SUBNORMAL 3
#define FP_NORMAL 4
${[
  'sqrt', 'fabs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'exp2', 'expm1', 'log', 'log2', 'log10', 'log1p', 'floor', 'ceil', 'trunc', 'round', 'cbrt',
].map((name) => `double ${name}(double);\nfloat ${name}f(float);`).join('\n')}
${['fmod', 'pow', 'atan2', 'hypot', 'fmin', 'fmax', 'fdim', 'copysign'].map((name) => `double ${name}(double, double);\nfloat ${name}f(float, float);`).join('\n')}
int isnan(double);
int isinf(double);
int isfinite(double);
int isnormal(double);
int signbit(double);
int fpclassify(double);`),
  'stdarg.h': guarded('stdarg.h', stdargBody),
  'stdbool.h': guarded('stdbool.h', `
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1`),
  'stddef.h': guarded('stddef.h', `
typedef unsigned long size_t;
typedef long ptrdiff_t;
typedef int wchar_t;
#define NULL ((void *)0)`),
  'stdint.h': guarded('stdint.h', stdintBody),
  'stdio.h': guarded('stdio.h', stdioBody),
  'wchar.h': guarded('wchar.h', `
#include <stddef.h>
typedef unsigned int wint_t;
#define WEOF ((wint_t)-1)`),
  'stdlib.h': guarded('stdlib.h', `
#include <stddef.h>
${HEAP_ALLOCATOR_BUILTINS.map((name) => HEAP_ALLOCATOR_SIGNATURES[name].prototype).join('\n')}
void free(void *);`),
  'string.h': guarded('string.h', stringBody),
};

export const STANDARD_HEADERS: Readonly<Record<string, string>> = Object.freeze(standardHeaders);
export function getStandardHeader(name: string): string | undefined { return STANDARD_HEADERS[name]; }
