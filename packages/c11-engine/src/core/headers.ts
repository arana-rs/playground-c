import { STDIO_FUNCTIONS, STDIO_HEADER_BODY } from './stdio-metadata.ts';
import { ERRNO_MACROS } from './errno-metadata.ts';
import { STDLIB_FUNCTIONS, STDLIB_HEADER_BODY, TIME_FUNCTIONS, TIME_HEADER_BODY } from './stdlib-time-metadata.ts';
import { STRING_FUNCTIONS } from './string-metadata.ts';
import {
  MATH_BINARY_FUNCTIONS, MATH_CLASSIFICATION_BUILTINS, MATH_CLASSIFICATION_FUNCTIONS,
  MATH_COMPARISON_BUILTINS, MATH_COMPARISON_MACROS,
  MATH_FMA_FUNCTIONS, MATH_INTEGER_RETURN_TYPES, MATH_NAN_FUNCTIONS, MATH_NEXTTOWARD_FUNCTIONS,
  MATH_OUT_UNARY_FUNCTIONS, MATH_REMQUO_FUNCTIONS, MATH_SCALING_FUNCTIONS, MATH_UNARY_FUNCTIONS,
} from './math-metadata.ts';

const guarded = (name: string, body: string): string => {
  const guard = `__C11_VIRTUAL_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return `#ifndef ${guard}\n#define ${guard} 1\n${body.trim()}\n#endif\n`;
};

const limitsMacros: Record<string, string> = {
  CHAR_BIT: '8', SCHAR_MIN: '(-127-1)', SCHAR_MAX: '127', UCHAR_MAX: '255', CHAR_MIN: '(-127-1)', CHAR_MAX: '127',
  MB_LEN_MAX: '1',
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
  LDBL_EPSILON: '0x1p-63L', LDBL_MIN: '0x1p-16382L', LDBL_MAX: '0x1.fffffffffffffffep16383L', LDBL_TRUE_MIN: '0x1p-16445L', LDBL_HAS_SUBNORM: '1',
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

const mathFloatVariantDeclarations = (name: string, parameterTypes: readonly [string, string, string], returnTypes: readonly [string, string, string] = ['double', 'float', 'long double']): string =>
  `${returnTypes[0]} ${name}(${parameterTypes[0]});\n${returnTypes[1]} ${name}f(${parameterTypes[1]});\n${returnTypes[2]} ${name}l(${parameterTypes[2]});`;

const mathUnaryDeclarations = MATH_UNARY_FUNCTIONS
  .map((name) => mathFloatVariantDeclarations(name, ['double', 'float', 'long double'])).join('\n');
const mathBinaryDeclarations = MATH_BINARY_FUNCTIONS
  .map((name) => mathFloatVariantDeclarations(name, ['double, double', 'float, float', 'long double, long double'])).join('\n');
const mathScalingDeclarations = MATH_SCALING_FUNCTIONS.map((name) => {
  const exponentType = name === 'scalbln' ? 'long' : 'int';
  return mathFloatVariantDeclarations(name, [`double, ${exponentType}`, `float, ${exponentType}`, `long double, ${exponentType}`]);
}).join('\n');
const mathOutUnaryDeclarations = MATH_OUT_UNARY_FUNCTIONS.map((name) => name === 'frexp'
  ? mathFloatVariantDeclarations(name, ['double, int *', 'float, int *', 'long double, int *'])
  : mathFloatVariantDeclarations(name, ['double, double *', 'float, float *', 'long double, long double *'])).join('\n');
const mathRemquoDeclarations = MATH_REMQUO_FUNCTIONS.map((name) => {
  const type = name === 'remquo' ? 'double' : name === 'remquof' ? 'float' : 'long double';
  return `${type} ${name}(${type}, ${type}, int *);`;
}).join('\n');
const mathNexttowardDeclarations = MATH_NEXTTOWARD_FUNCTIONS.map((name) => {
  const type = name === 'nexttoward' ? 'double' : name === 'nexttowardf' ? 'float' : 'long double';
  return `${type} ${name}(${type}, long double);`;
}).join('\n');
const mathIntegerReturnDeclarations = Object.entries(MATH_INTEGER_RETURN_TYPES).flatMap(([name, returnType]) => [
  `${returnType} ${name}(double);`, `${returnType} ${name}f(float);`, `${returnType} ${name}l(long double);`,
]).join('\n');
const mathNanDeclarations = MATH_NAN_FUNCTIONS.map((name) => {
  const type = name === 'nan' ? 'double' : name === 'nanf' ? 'float' : 'long double';
  return `${type} ${name}(const char *);`;
}).join('\n');
const mathClassificationFunctionDeclarations = MATH_CLASSIFICATION_FUNCTIONS.map((name) => `int ${name}(double);`).join('\n');
const mathClassificationDeclarations = MATH_CLASSIFICATION_BUILTINS.map((name) => `int ${name}(double);`).join('\n');
const mathClassificationMacros = MATH_CLASSIFICATION_FUNCTIONS.map((name, index) =>
  `#define ${name}(x) ${MATH_CLASSIFICATION_BUILTINS[index]!}((x))`,
).join('\n');
const mathComparisonDeclarations = MATH_COMPARISON_BUILTINS.map((name) => `int ${name}(double, double);`).join('\n');
const mathComparisonMacros = MATH_COMPARISON_MACROS.map((name, index) =>
  `#define ${name}(x, y) ${MATH_COMPARISON_BUILTINS[index]!}((x), (y))`,
).join('\n');
const stdioFunctions = STDIO_FUNCTIONS;
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
  'stdalign.h': Object.freeze([]),
  'stdbool.h': Object.freeze([]),
  'stddef.h': Object.freeze([]),
  'stdint.h': Object.freeze([]),
  'stdio.h': Object.freeze(stdioFunctions),
  'stdlib.h': STDLIB_FUNCTIONS,
  'string.h': STRING_FUNCTIONS,
  'time.h': TIME_FUNCTIONS,
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

const stdioBody = STDIO_HEADER_BODY;

const stringBody = `
#include <stddef.h>
void *memcpy(void * restrict, const void * restrict, size_t);
void *memmove(void *, const void *, size_t);
void *memset(void *, int, size_t);
int memcmp(const void *, const void *, size_t);
void *memchr(const void *, int, size_t);
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
  // Each inclusion must sample the current NDEBUG definition.
  'assert.h': `
#undef assert
#ifdef NDEBUG
#define assert(expression) ((void)0)
#else
void __c11_assert_fail(const char *, const char *, unsigned long);
#define assert(expression) ((expression) ? (void)0 : __c11_assert_fail(#expression, __FILE__, __LINE__))
#endif
#define static_assert _Static_assert
`,
  'ctype.h': guarded('ctype.h', ctypeFunctions.map((name) => `int ${name}(int);`).join('\n')),
  'errno.h': guarded('errno.h', `
extern int *__c11_errno_location(void);
#define errno (*__c11_errno_location())
${Object.entries(ERRNO_MACROS).map(([name, value]) => `#define ${name} ${value}`).join('\n')}`),
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
#define HUGE_VALL ((long double)__c11_inf())
#define NAN (__c11_nan())
#define FP_NAN 0
#define FP_INFINITE 1
#define FP_ZERO 2
#define FP_SUBNORMAL 3
#define FP_NORMAL 4
#define FP_ILOGB0 (-2147483647-1)
#define FP_ILOGBNAN (-2147483647-1)
#define MATH_ERRNO 1
#define MATH_ERREXCEPT 2
#define math_errhandling MATH_ERRNO
typedef float float_t;
typedef double double_t;
${mathUnaryDeclarations}
${mathBinaryDeclarations}
${mathScalingDeclarations}
${mathOutUnaryDeclarations}
${mathRemquoDeclarations}
${mathNexttowardDeclarations}
${mathIntegerReturnDeclarations}
${mathNanDeclarations}
${MATH_FMA_FUNCTIONS.map((name) => `${name === 'fma' ? 'double' : name === 'fmaf' ? 'float' : 'long double'} ${name}(${name === 'fma' ? 'double, double, double' : name === 'fmaf' ? 'float, float, float' : 'long double, long double, long double'});`).join('\n')}
${mathClassificationFunctionDeclarations}
${mathClassificationDeclarations}
${mathComparisonDeclarations}
${mathClassificationMacros}
${mathComparisonMacros}`),
  'stdarg.h': guarded('stdarg.h', stdargBody),
  'stdalign.h': guarded('stdalign.h', `
#define alignas _Alignas
#define alignof _Alignof
#define __alignas_is_defined 1
#define __alignof_is_defined 1`),
  'stdbool.h': guarded('stdbool.h', `
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1`),
  'stddef.h': guarded('stddef.h', `
typedef unsigned long size_t;
typedef long ptrdiff_t;
typedef struct { long long __c11_max_align_ll; long double __c11_max_align_ld; } max_align_t;
#define offsetof(type, member) __builtin_offsetof(type, member)
#define NULL ((void *)0)`),
  'stdint.h': guarded('stdint.h', stdintBody),
  'stdio.h': guarded('stdio.h', stdioBody),
  'stdlib.h': guarded('stdlib.h', STDLIB_HEADER_BODY),
  'string.h': guarded('string.h', stringBody),
  'time.h': guarded('time.h', TIME_HEADER_BODY),
};

export const STANDARD_HEADERS: Readonly<Record<string, string>> = Object.freeze(standardHeaders);
export function getStandardHeader(name: string): string | undefined { return STANDARD_HEADERS[name]; }
