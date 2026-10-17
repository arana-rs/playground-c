#include <stdio.h>
#include <stdlib.h>

struct Dato {
    char etiqueta;
    int valor;
    int *referencia;
};

int main(void) {
    printf("Tamano del texto (8-64): ");
    int solicitado = 0;
    int lectura = scanf("%d", &solicitado);
    if (lectura == EOF) {
        puts("\nFin de entrada; no se reservo memoria.");
        return 0;
    }
    if (lectura != 1) {
        puts("Entrada invalida: escribe un entero.");
        return 1;
    }
    if (solicitado < 8 || solicitado > 64) {
        puts("El tamano debe estar entre 8 y 64 bytes.");
        return 1;
    }

    size_t capacidad = (size_t)solicitado;
    char *texto = malloc(capacidad);
    if (texto == NULL) {
        fprintf(stderr, "No se pudo reservar %d bytes.\n", solicitado);
        return 1;
    }

    int base = solicitado;
    struct Dato dato = { 'A', solicitado, &base };
    struct Dato *vista = &dato;
    vista->etiqueta = 'B';
    vista->valor++;
    *dato.referencia = vista->valor;

    int longitud = snprintf(texto, capacidad, "%c:%d/%d", dato.etiqueta, dato.valor, base);
    if (longitud < 0 || (size_t)longitud >= capacidad) {
        fprintf(stderr, "El texto no cabe en los %d bytes solicitados.\n", solicitado);
        free(texto);
        return 1;
    }

    size_t capacidad_ampliada = capacidad + 8;
    char *ampliado = realloc(texto, capacidad_ampliada);
    if (ampliado == NULL) {
        fprintf(stderr, "No se pudo ampliar; se conserva el texto original: %s\n", texto);
        free(texto);
        return 1;
    }
    texto = ampliado;

    FILE *archivo = fopen("demo.txt", "w+");
    if (archivo == NULL) {
        fprintf(stderr, "No se pudo abrir demo.txt.\n");
        free(texto);
        return 1;
    }
    if (fprintf(archivo, "%s\n", texto) < 0) {
        fprintf(stderr, "No se pudo escribir demo.txt.\n");
        fclose(archivo);
        free(texto);
        return 1;
    }

    rewind(archivo);
    char recuperado[80];
    if (fgets(recuperado, sizeof recuperado, archivo) == NULL) {
        fprintf(stderr, "No se pudo leer demo.txt.\n");
        fclose(archivo);
        free(texto);
        return 1;
    }
    if (fclose(archivo) == EOF) {
        fprintf(stderr, "No se pudo cerrar demo.txt.\n");
        free(texto);
        return 1;
    }

    long double tercio = 1.0L / 3.0L;
    printf("Memoria dinamica: %s (base=%d)\n", texto, base);
    printf("Archivo virtual, leido y cerrado: %s", recuperado);
    printf("Un tercio en long double: %.21Lg\n", tercio);
    free(texto);
    return 0;
}
