enum Estado { INACTIVO, LISTO = 4, COMPLETO };

int ajustar(int parametro) {
    int local = parametro;
    local += 1;
    return local;
}

int main(void) {
    long largo = 9007199254740993L;
    long long muy_largo = -9223372036854775807LL - 1LL;
    unsigned long long sin_signo = 18446744073709551615ULL;
    _Bool activo = 9;
    char letra = 'C';
    char nueva_linea = '\n';
    char comilla = '\'';
    short corto = -1234;
    float decimal = 3.5f;
    double precision = 2.718281828459045;
    double cero_negativo = -0.0;
    enum Estado estado = LISTO;
    int pendiente;
    int mutable = 1;
    {
        short temporal = 27;
        mutable = 2;
    }
    int resultado = ajustar(mutable);
    return resultado == 3 ? 0 : 1;
}
