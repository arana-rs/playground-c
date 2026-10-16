#include <stdio.h>

struct Dato {
    char etiqueta;
    int valor;
    int *enlace;
};

int main(void) {
    int base = 4;
    struct Dato dato = { 'A', 12, &base };
    struct Dato *vista = &dato;

    dato.valor = 20;
    vista->etiqueta = 'B';
    *dato.enlace = vista->valor;
    printf("%c: %d (base=%d)\n", dato.etiqueta, vista->valor, base);
    return 0;
}
