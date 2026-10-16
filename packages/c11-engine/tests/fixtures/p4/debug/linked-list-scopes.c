struct Nodo {
    int valor;
    struct Nodo *siguiente;
};

void appendNode(struct Nodo **head, struct Nodo *node) {
    struct Nodo **cursor = head;
    while (*cursor != 0) {
        cursor = &(*cursor)->siguiente;
    }
    *cursor = node;
}

int main(void) {
    struct Nodo primero = {10, 0};
    struct Nodo segundo = {20, 0};
    struct Nodo tercero = {30, 0};
    struct Nodo *lista = 0;

    appendNode(&lista, &primero);
    appendNode(&lista, &segundo);
    appendNode(&lista, &tercero);

    if (lista != &primero || primero.siguiente != &segundo ||
        segundo.siguiente != &tercero || tercero.siguiente != 0 ||
        primero.valor != 10 || segundo.valor != 20 || tercero.valor != 30) {
        return 1;
    }

    int temporal_correcto = 0;
    {
        struct Nodo temporal = {40, 0};
        appendNode(&lista, &temporal);
        temporal_correcto = tercero.siguiente == &temporal &&
            temporal.valor == 40 && temporal.siguiente == 0;
        tercero.siguiente = 0;
    }

    if (temporal_correcto == 0 || lista != &primero ||
        primero.siguiente != &segundo || segundo.siguiente != &tercero ||
        tercero.siguiente != 0) {
        return 2;
    }

    return 0;
}
