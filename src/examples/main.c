#include <stdio.h>
#include <stdlib.h>
#include <time.h>

enum { CANTIDAD = 10, LIMITE = 100 };

int main(void) {
    int numeros[CANTIDAD];

    srand((unsigned int)time(NULL));

    for (int i = 0; i < CANTIDAD; i++) {
        numeros[i] = rand() % LIMITE;
    }

    printf("Arreglo con %d numeros aleatorios entre 0 y %d:\n", CANTIDAD, LIMITE - 1);
    for (int i = 0; i < CANTIDAD; i++) {
        printf("numeros[%d] = %d\n", i, numeros[i]);
    }

    return 0;
}
