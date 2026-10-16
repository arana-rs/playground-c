/* P2–P4: escalares LP64, expresiones, control, objetos, preprocesador y libc.
 * Run: exit code 42 = todo correcto. Si falla un grupo:
 * 1 tipos/headers, 2 enteros, 3 flotantes, 4 operadores,
 * 5 control, 6 funciones, 7 math double, 8 math float,
 * 9 arrays/designadores/strings, 10 punteros/funciones/stddef,
 * 11 agregados/bytes/enums/miembros anónimos,
 * 12 globals/compound literals/heap, 13 traducción/macros/argv,
 * 14 linkage/inline/K&R/varargs, 15 stdio/formato/archivos virtuales,
 * 16 string/ctype/errno/inttypes/assert.
 * Cada grupo P4 correcto imprime una línea en la consola.
 */
#include <assert.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <float.h>
#include <inttypes.h>
#include <iso646.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define P4_ANSWER 42
#define P4_PASTE_RAW(left, right) left##right
#define P4_PASTE(left, right) P4_PASTE_RAW(left, right)
#define P4_STRING_RAW(value) #value
#define P4_STRING(value) P4_STRING_RAW(value)
#define P4_PRINT(...) printf(__VA_ARGS__)
#define P4_TEMPORARY 1
#undef P4_TEMPORARY
#if defined(P4_ANSWER) && P4_ANSWER == 42
#define P4_CONDITIONAL_OK 1
#else
#error P4 macro condition failed
#endif
#ifndef P4_TEMPORARY
#define P4_UNDEF_OK 1
#endif
#pragma STDC FP_CONTRACT OFF

struct Pareja { int izquierda; int derecha; };
union Numero { unsigned int valor; unsigned char bytes[4]; };

int visitas = 8;
static int totales[2];
int *valores_estaticos = (int[]) { 40, 2 };

int tipos(void);
int enteros(void);
int flotantes(void);
int operadores(void);
int control(void);
int funciones(void);
int matematicas_double(void);
int matematicas_float(void);
int arrays_designadores(void);
int punteros(void);
int agregados(void);
int globals_y_heap(void);
int preprocesador_y_argumentos(int argc, char **argv);
int funciones_p4(void);
int stdio_p4(void);
int biblioteca_p4(void);
long factorial(int n);
bool par(int n);
bool impar(int n);
unsigned char siguiente(unsigned char value);
float redondear(double value);
int sumar_copia(int value);
void pausa(void);
int sumar_array(int values[], int count);
int incrementar(int value);
int aplicar(int (*operation)(int), int value);
struct Pareja ajustar_pareja(struct Pareja value);
int visitar_global(void);

int main(int argc, char **argv) {
    if (!tipos()) return 1;
    if (!enteros()) return 2;
    if (!flotantes()) return 3;
    if (!operadores()) return 4;
    if (!control()) return 5;
    if (!funciones()) return 6;
    if (!matematicas_double()) return 7;
    if (!matematicas_float()) return 8;
    if (!arrays_designadores()) return 9;
    if (!punteros()) return 10;
    if (!agregados()) return 11;
    if (!globals_y_heap()) return 12;
    if (!preprocesador_y_argumentos(argc, argv)) return 13;
    P4_PRINT("P4 macros, conditional, #undef y argv: ok\n");
    if (!funciones_p4()) return 14;
    P4_PRINT("P4 static inline, K&R y va_copy: ok\n");
    if (!stdio_p4()) return 15;
    P4_PRINT("P4 printf/snprintf y archivo binario virtual: ok\n");
    if (!biblioteca_p4()) return 16;
    P4_PRINT("P4 string, ctype, errno, inttypes y assert: ok\n");
    return 42;
}

static inline int sumar_p4(int left, int right) {
    return left + right;
}

static int estilo_antiguo_p4(value)
int value;
{
    return value + 1;
}

static int recolectar_p4(int count, ...) {
    va_list original;
    va_list copia;
    va_start(original, count);
    va_copy(copia, original);

    int primero = va_arg(original, int);
    double promovido = va_arg(original, double);
    int tercero = va_arg(original, int);
    int copia_primero = va_arg(copia, int);
    int copia_segundo = va_arg(copia, double) == 2.5;

    va_end(copia);
    va_end(original);
    return count == 3 && primero == 9 && promovido == 2.5
        && tercero == 33 && copia_primero == 9 && copia_segundo;
}

int preprocesador_y_argumentos(int argc, char **argv) {
    int P4_PASTE(p4_, respuesta) = P4_ANSWER;
    const char *texto = P4_STRING(P4_ANSWER);
    return argc == 1 && argv != NULL && argv[0] != NULL && argv[1] == NULL
        && argv[0][0] == 'm' && argv[0][1] == 'a' && argv[0][2] == 'i'
        && argv[0][3] == 'n' && argv[0][4] == '.' && argv[0][5] == 'c'
        && argv[0][6] == '\0' && P4_CONDITIONAL_OK && P4_UNDEF_OK
        && p4_respuesta == 42 && strcmp(texto, "42") == 0;
}

int funciones_p4(void) {
    short entero_promovido = 9;
    float real_promovido = 2.5f;
    assert(sumar_p4(40, 2) == 42);
    return sumar_p4(20, 22) == 42
        && estilo_antiguo_p4(41) == 42
        && recolectar_p4(3, entero_promovido, real_promovido, 33);
}

int stdio_p4(void) {
    char buffer[32];
    int longitud = snprintf(buffer, sizeof buffer, "%s:%" PRIu64, "value", UINT64_C(42));
    if (longitud != 8 || strcmp(buffer, "value:42") != 0) return 0;
    if (printf("P4 output %s\n", buffer) < 0) return 0;

    FILE *file = fopen("p4-example.bin", "w+b");
    if (file == NULL) return 0;
    const unsigned char expected[3] = { 'A', 0, 'B' };
    if (fwrite(expected, 1, 3, file) != 3 || ftell(file) != 3) return 0;
    if (fseek(file, 0, SEEK_SET) != 0) return 0;
    unsigned char actual[3] = { 0, 0, 0 };
    if (fread(actual, 1, 3, file) != 3) return 0;
    if (fgetc(file) != EOF || !feof(file) || ferror(file)) return 0;
    if (ungetc('Z', file) == EOF || feof(file) || fgetc(file) != 'Z') return 0;
    if (fseek(file, 2, SEEK_SET) != 0 || fgetc(file) != 'B') return 0;
    if (fclose(file) != 0) return 0;
    return actual[0] == 'A' && actual[1] == 0 && actual[2] == 'B';
}

int biblioteca_p4(void) {
    int32_t parsed = 0;
    if (sscanf("42", "%" SCNd32, &parsed) != 1 || parsed != 42) return 0;
    if (!isalpha('A') || !isdigit('7') || tolower('Q') != 'q') return 0;

    char text[16] = "abc";
    memmove(text + 1, text, 3);
    if (strcmp(text, "aabc") != 0 || strlen(text) != 4) return 0;
    char words[] = "red,green,blue";
    char *first = strtok(words, ",");
    char *second = strtok(NULL, ",");
    if (first == NULL || second == NULL || strcmp(first, "red") != 0
        || strcmp(second, "green") != 0) return 0;

    errno = 0;
    intmax_t overflow = strtoimax("999999999999999999999999", NULL, 10);
    return overflow == INTMAX_MAX && errno == ERANGE;
}

// Todos los tipos escalares disponibles y constantes del perfil Linux.
int tipos(void) {
    _Bool normalizado = 9;
    bool activo = true;
    char c = '\n';
    signed char sc = -2;
    unsigned char uc = 255;
    short s = -300;
    unsigned short us = 65535;
    int i = 42;
    unsigned int ui = 42U;
    long l = 42L;
    unsigned long ul = 42UL;
    long long ll = 42LL;
    unsigned long long ull = 42ULL;
    float f = 1.25f;
    double d = 0x1.4p0;
    return normalizado == 1 && activo && !false
        && c == 10 && sc == -2 && uc == UCHAR_MAX
        && s == -300 && us == USHRT_MAX && i == ui
        && l == ul && ll == ull && f == d
        && sizeof(_Bool) == 1 && sizeof(char) == 1
        && sizeof(short) == 2 && sizeof(int) == 4
        && sizeof(long) == 8 && sizeof(long long) == 8
        && sizeof(float) == 4 && sizeof(double) == 8
        && CHAR_BIT == 8 && CHAR_MIN == SCHAR_MIN && CHAR_MAX == SCHAR_MAX
        && INT_MAX == 2147483647 && LONG_MAX == LLONG_MAX
        && FLT_RADIX == 2 && FLT_MANT_DIG == 24 && DBL_MANT_DIG == 53
        && FLT_EVAL_METHOD == 0 && __bool_true_false_are_defined == 1
        && sizeof(int8_t) == 1 && sizeof(uint16_t) == 2
        && sizeof(int32_t) == 4 && sizeof(uint64_t) == 8
        && sizeof(int_least16_t) == 2 && sizeof(int_fast32_t) == 8
        && sizeof(intmax_t) == 8 && sizeof(uintptr_t) == 8;
}

// 64 bits exactos, wrap unsigned, promociones, casts y escapes.
int enteros(void) {
    uint64_t exacto = 9007199254740993ULL;
    uint64_t envuelto = UINT64_MAX + 1ULL;
    int64_t minimo = INT64_MIN;
    unsigned char pequeno = 255;
    return exacto - 9007199254740992ULL == 1ULL && envuelto == 0
        && minimo == LONG_MIN && UINT64_MAX == ULLONG_MAX
        && pequeno + 1 == 256 && sizeof(pequeno + 1) == 4
        && !(-1 < 1U) && (unsigned int)-1 == UINT_MAX
        && (signed char)255 == -1 && (int)3.75 == 3
        && 42 == 052 && 42 == 0x2a && '\101' == '\x41'
        && '\t' == 9 && '\r' == 13 && '\\' == 92 && '\'' == 39;
}

// Binary32/binary64, cero negativo, NaN, infinito y subnormales.
int flotantes(void) {
    float redondeado = (float)16777217;
    float diminuto = FLT_TRUE_MIN;
    double negativo = -0.0;
    double nan = NAN;
    double infinito = INFINITY;
    return redondeado == 16777216.0f && .5e1 == 0x1.4p2
        && FLT_EPSILON == 0x1p-23f && DBL_EPSILON == 0x1p-52
        && diminuto > 0.0f && fpclassify(diminuto) == FP_SUBNORMAL
        && fpclassify(DBL_TRUE_MIN) == FP_SUBNORMAL
        && negativo == 0.0 && signbit(negativo)
        && fpclassify(negativo) == FP_ZERO
        && isnan(nan) && nan != nan && !(nan < 1.0)
        && fpclassify(nan) == FP_NAN
        && isinf(infinito) && !isfinite(infinito)
        && fpclassify(infinito) == FP_INFINITE
        && isfinite(1.0) && isnormal(FLT_MIN) && !isnormal(diminuto)
        && fpclassify(1.0) == FP_NORMAL
        && isnan(sqrt(-1.0)) && isinf(HUGE_VAL) && isinf(HUGE_VALF);
}

// Cortocircuito y coma secuencian efectos; sizeof no ejecuta ++.
int operadores(void) {
    int x = 0;
    int y = 0;
    int z = (x = y = 5);
    if (x != 5 || y != 5 || z != 5) return 0;
    x = 0;
    0 && ++x;
    1 || ++x;
    if (x != 0 || sizeof(++x) != 4 || x != 0) return 0;
    y = 1 ? (x = 2) : ++x;
    z = 0 ? ++x : (x += 3);
    if (x != 5 || y != 2 || z != 5) return 0;
    y = (x = 2, x += 3, x * 4);
    if (x != 5 || y != 20 || sizeof(1 ? 1.0f : 2.0) != 8) return 0;
    int i = 4;
    int a = i++;
    int b = ++i;
    int c = i--;
    int d = --i;
    if (a != 4 || b != 6 || c != 6 || d != 4 || i != 4) return 0;
    int n = 10;
    n += 2; n -= 3; n *= 4; n /= 6; n %= 4;
    n <<= 3; n >>= 2; n |= 3; n ^= 6; n &= 1;
    (void)n;
    return n == 1 && +i == 4 && -i == -4 && !0 && ~0U == UINT_MAX
        && 2 + 3 == 5 && 7 - 2 == 5 && 3 * 4 == 12
        && -7 / 3 == -2 && -7 % 3 == -1
        && (1U << 4) == 16U && (16U >> 2) == 4U && (-8 >> 2) == -2
        && (6 & 3) == 2 && (6 ^ 3) == 5 && (6 | 3) == 7
        && i == 4 && i != 5 && i < 5 && i <= 4 && i > 3 && i >= 4;
}

// Scopes, ramas, switch con fallthrough y las tres clases de bucle.
int control(void) {
    int x = 1;
    { int x = 8; ++x; if (x != 9) return 0; }
    if (x == 1) x = 3; else x = 99;
    int selector = 1;
    switch (selector++) {
        case 0: x = 99; break;
        case 1: x += 2; /* fallthrough */
        case 2: x += 3; break;
        default: x = 99;
    }
    if (x != 8 || selector != 2) return 0;
    switch (99) { case 1: return 0; default: x = 4; }
    int i = 99;
    int suma = 0;
    for (int i = 0; i < 6; ++i) {
        if (i == 2) continue;
        if (i == 5) break;
        suma += i;
    }
    if (i != 99 || suma != 8) return 0;
    i = 0; suma = 0;
    while (i < 6) {
        ++i;
        if (i == 2) continue;
        if (i == 5) break;
        suma += i;
    }
    if (suma != 8) return 0;
    i = 0; suma = 0;
    do { ++i; if (i == 2) continue; suma += i; } while (i < 3);
    if (suma != 4 || x != 4) return 0;
    // Goto hacia delante, hacia atras y fuera de un bloque.
    int pasos = 0;
    goto repetir;
    pasos = 99;
repetir: ;
    ++pasos;
    if (pasos < 3) goto repetir;
    { int extra = 4; pasos += extra; goto fin; }
fin:
    return pasos == 7;
}

// Prototipos, paso por valor, conversion de retorno y frames recursivos.
int funciones(void) {
    int original = 2;
    int copia = sumar_copia(original);
    int argumento = 511;
    pausa();
    // El parametro reduce 511 a 255; el retorno reduce 256 a 0.
    return original == 2 && copia == 9 && siguiente(argumento) == 0
        && redondear(16777217.0) == 16777216.0f
        && factorial(20) == 2432902008176640000L && par(24) && impar(23);
}
int sumar_copia(int value) { value += 7; return value; }
unsigned char siguiente(unsigned char value) { return value + 1; }
float redondear(double value) { return value; }
void pausa(void) { return; }
long factorial(int n) {
    if (n <= 1) return 1L;
    long guardado = n;
    return guardado * factorial(n - 1);
}
bool par(int n) { if (n == 0) return true; return impar(n - 1); }
bool impar(int n) { if (n == 0) return false; return par(n - 1); }

// Las 34 funciones double: argumentos con resultados exactos simples.
int matematicas_double(void) {
    return sqrt(81.0) == 9.0 && fabs(-2.5) == 2.5
        && sin(0.0) == 0.0 && cos(0.0) == 1.0 && tan(0.0) == 0.0
        && asin(0.0) == 0.0 && acos(1.0) == 0.0 && atan(0.0) == 0.0
        && sinh(0.0) == 0.0 && cosh(0.0) == 1.0 && tanh(0.0) == 0.0
        && asinh(0.0) == 0.0 && acosh(1.0) == 0.0 && atanh(0.0) == 0.0
        && exp(0.0) == 1.0 && exp2(3.0) == 8.0 && expm1(0.0) == 0.0
        && log(1.0) == 0.0 && log2(8.0) == 3.0 && log10(1.0) == 0.0
        && log1p(0.0) == 0.0 && floor(-2.5) == -3.0 && ceil(-2.5) == -2.0
        && trunc(-2.5) == -2.0 && round(-2.5) == -3.0 && cbrt(8.0) == 2.0
        && fmod(-7.0, 3.0) == -1.0 && pow(2.0, 10.0) == 1024.0
        && atan2(0.0, 1.0) == 0.0 && hypot(3.0, 4.0) == 5.0
        && fmin(2.0, 3.0) == 2.0 && fmax(2.0, 3.0) == 3.0
        && fdim(3.0, 2.0) == 1.0 && copysign(2.0, -1.0) == -2.0;
}

// Las mismas 34 funciones con precision float y sufijo f.
int matematicas_float(void) {
    return sqrtf(81.0f) == 9.0f && fabsf(-2.5f) == 2.5f
        && sinf(0.0f) == 0.0f && cosf(0.0f) == 1.0f && tanf(0.0f) == 0.0f
        && asinf(0.0f) == 0.0f && acosf(1.0f) == 0.0f && atanf(0.0f) == 0.0f
        && sinhf(0.0f) == 0.0f && coshf(0.0f) == 1.0f && tanhf(0.0f) == 0.0f
        && asinhf(0.0f) == 0.0f && acoshf(1.0f) == 0.0f && atanhf(0.0f) == 0.0f
        && expf(0.0f) == 1.0f && exp2f(3.0f) == 8.0f && expm1f(0.0f) == 0.0f
        && logf(1.0f) == 0.0f && log2f(8.0f) == 3.0f && log10f(1.0f) == 0.0f
        && log1pf(0.0f) == 0.0f && floorf(-2.5f) == -3.0f && ceilf(-2.5f) == -2.0f
        && truncf(-2.5f) == -2.0f && roundf(-2.5f) == -3.0f && cbrtf(8.0f) == 2.0f
        && fmodf(-7.0f, 3.0f) == -1.0f && powf(2.0f, 10.0f) == 1024.0f
        && atan2f(0.0f, 1.0f) == 0.0f && hypotf(3.0f, 4.0f) == 5.0f
        && fminf(2.0f, 3.0f) == 2.0f && fmaxf(2.0f, 3.0f) == 3.0f
        && fdimf(3.0f, 2.0f) == 1.0f && copysignf(2.0f, -1.0f) == -2.0f;
}

// Arrays multidimensionales, decay, designadores, brace elision y NUL.
int arrays_designadores(void) {
    int matriz[2][3] = { [1][2] = 9, [0] = { 3, 4 } };
    int plana[2][2] = { 1, 2, 3, 4 };
    char texto[] = "C11";
    char *literal = "C11";
    texto[1] = '8';
    return sizeof(matriz) == 24 && sizeof(matriz[0]) == 12
        && matriz[0][0] == 3 && matriz[0][1] == 4 && matriz[0][2] == 0
        && matriz[1][0] == 0 && matriz[1][2] == 9
        && plana[1][0] == 3 && plana[1][1] == 4
        && sumar_array(matriz[1], 3) == 9
        && sizeof(texto) == 4 && texto[1] == '8' && texto[3] == '\0'
        && sizeof("C11") == 4 && literal[3] == '\0';
}
int sumar_array(int values[], int count) {
    int total = 0;
    for (int index = 0; index < count; ++index) total += values[index];
    return sizeof(values) == sizeof(int *) ? total : -1;
}

// Conversión void *, one-past, aritmética, llamadas por puntero y stddef.
int punteros(void) {
    int values[3] = { 10, 20, 12 };
    int *begin = values;
    int *end = begin + 3;
    void *opaque = begin + 1;
    int *alias = (int *)opaque;
    int *null_pointer = NULL;
    size_t byte_count = sizeof(values);
    ptrdiff_t element_count = end - begin;
    int (*operation)(int) = incrementar;
    *alias += 1;
    return values[1] == 21 && alias == begin + 1 && *alias == 21
        && element_count == 3 && byte_count == 12 && end == &values[3]
        && aplicar(operation, 41) == 42 && null_pointer == 0;
}
int incrementar(int value) { return value + 1; }
int aplicar(int (*operation)(int), int value) { return operation(value); }

// Copia de agregados, miembros anónimos, enums, -> y vista little-endian.
int agregados(void) {
    enum Estado { INICIO, LISTO = 4, TERMINADO };
    struct Registro {
        int etiqueta;
        struct { int izquierda; int derecha; };
        union { int codigo; unsigned int bits; };
    };
    struct Registro registro = {
        .derecha = 22, .etiqueta = 1, .izquierda = 20, .codigo = 42
    };
    enum Estado estado = TERMINADO;
    struct Pareja original = { .derecha = 22, .izquierda = 20 };
    struct Pareja copia = original;
    struct Pareja cambiada = ajustar_pareja(copia);
    struct Pareja *vista = &(struct Pareja) { .derecha = 4, .izquierda = 3 };
    union Numero numero = { .valor = 0x12345678U };
    unsigned char *bytes = (unsigned char *)&numero;
    vista->izquierda += vista->derecha;
    return registro.etiqueta == 1 && registro.izquierda == 20
        && registro.derecha == 22 && registro.codigo == 42
        && estado == 5 && LISTO == 4 && INICIO == 0
        && sizeof(original) == 8 && sizeof(numero) == 4
        && original.izquierda == 20 && copia.izquierda == 20
        && cambiada.izquierda == 21 && cambiada.derecha == 22
        && vista->izquierda == 7 && vista->derecha == 4
        && numero.valor == 0x12345678U
        && bytes[0] == 0x78 && bytes[1] == 0x56
        && bytes[2] == 0x34 && bytes[3] == 0x12;
}
struct Pareja ajustar_pareja(struct Pareja value) {
    ++value.izquierda;
    return value;
}

// Globals reiniciables, compound literals automáticos/estáticos y heap básico.
int globals_y_heap(void) {
    int *temporal = &(int) { 40 };
    int *heap = malloc(2 * sizeof(int));
    if (heap == NULL) return 0;
    heap[0] = 17;
    heap[1] = 25;
    int despues = visitar_global();
    int suma_estatica = valores_estaticos[0] + valores_estaticos[1];
    int suma_heap = heap[0] + heap[1];
    free(heap);
    free(NULL);
    return despues == 9 && visitas == 9 && totales[0] == 0 && totales[1] == 1
        && suma_estatica == 42 && *temporal == 40 && suma_heap == 42;
}
int visitar_global(void) {
    ++visitas;
    ++totales[1];
    return visitas;
}

/* Para explorar diagnosticos, cambia temporalmente un return de main:
 * return INT_MAX + 1;       // Overflow firmado.
 * return 7 / 0;             // Division entera por cero.
 * return 1 << 32;           // Shift invalido.
 * int x; return x;          // Local sin inicializar.
 * return (int)1e100;        // Conversion fuera de rango.
 * int x = 0; return x++ + x;// Accesos sin secuenciar.
 * while (1) {}              // Se detiene por limite; Stop cancela.
 * Quitar return de main termina con 0; usar un retorno ausente falla.
 */
