# UI condensada propia

Esta guía define la dirección visual del playground y del Memory Viewer. Describe la interfaz del proyecto; las implementaciones y sus valores vigentes siguen en los componentes y en `../src/style.css`. Antes de cambiar un estilo, reutiliza sus tokens y patrones existentes. No mantengas aquí una segunda copia de la paleta ni de las medidas CSS.

La interfaz es compacta para dejar espacio al código, la consola y las regiones de memoria. Usa superficies sobrias, separadores finos y radios pequeños. Reserva el acento para foco, selección, ejecución y acciones. La jerarquía debe venir del orden, el peso tipográfico y el contraste, sin marcos o sombras decorativas repetidos.

## Tokens y temas

`../src/style.css` es la fuente única de los tokens visuales compartidos y sus valores por tema. Usa las variables existentes según su función: superficies (`--bg`, `--bg2`, `--bg3`, `--bg4`, `--chrome`), texto (`--fg`, `--dim`, `--faint`), divisores (`--line`), interacción (`--accent`, `--accent-fg`, `--selection`), sintaxis (`--syntax-*`), estados (`--status-*`) y memoria (`--memory-*`). Si una necesidad visual nueva encaja en uno de esos roles, reutiliza ese token en vez de crear un alias o una paleta local paralela. Mantén las variables específicas de componentes acotadas a su componente.

La aplicación admite `github-dark` y `github-light`, seleccionables desde el control de tema y guardados en `localStorage` con la clave `c-playground-color-theme`. Se aplican mediante `data-theme`; si no hay una preferencia válida o el almacenamiento no está disponible, se usa GitHub Dark. Conserva la sintaxis correspondiente a cada tema con los mismos roles `--syntax-*`; no fijes colores de sintaxis directamente en los componentes.

## Densidad, tipografía y estructura

La interfaz usa la pila de sistema `--ui` y reserva `--mono` para código, salida, direcciones y valores. El tamaño base actual es 13 px. El editor usa 13,5 px con interlineado de 21 px y tabulación de cuatro espacios; la consola usa 12,5/18 px. Estos valores concretos se mantienen en CSS, que es la referencia al ajustarlos.

Mantén compactos el encabezado, la pestaña del archivo, los controles y las cabeceras de sección. El editor y los resultados ocupan el área de trabajo disponible; separadores finos organizan el encabezado, las pestañas, la consola y las regiones de memoria. El tamaño y la disposición pueden responder al viewport, teclado y redimensionamiento de la consola, conservando el contenido útil y los controles accesibles.

Los paneles usan títulos breves y discretos; sus cabeceras distinguen el chrome del contenido sin competir con el código. La pestaña activa, el estado actual y la línea de ejecución se reconocen con acento o selección. Los estados también deben tener texto o una señal adicional al color. Conserva el foco visible en controles de teclado.

## Controles y ejecución

Reutiliza el `Button` de Arc para las acciones y su integración existente con la paleta compacta. Run y Stop conservan el tamaño y peso del chrome. Durante una ejecución, Run cambia a Stop y Stop sigue habilitado para cancelar. El mismo control de cancelación permanece disponible en la depuración cuando está activa.

El selector de tema sigue siendo compacto y accesible. Los controles de modo, I/O, historial y cierre del Memory Viewer mantienen sus etiquetas, estados de foco y disponibilidad contextual.

## Editor

El editor da prioridad al texto de C, con números de línea y diagnósticos alineados en un gutter discreto. La línea de ejecución puede resaltarse sin ocultar el texto ni reemplazar el foco de edición. La sintaxis usa el escáner compartido del proyecto y los roles de color del tema activo.

Los cambios de presentación, las actualizaciones de estado y Run deben conservar las ediciones del usuario. Mantén selección y cursor, deshacer y rehacer, sangría, pares de delimitadores, composición IME y desplazamiento. El ejemplo inicial es `../src/examples/main.c`; no lo dupliques en la guía ni en componentes.

## Consola

La consola queda debajo del editor, separada por una línea fina y con divisor redimensionable. Su cabecera muestra el estado en texto y con una señal visual. La salida usa tipografía mono, conserva stdout y stderr y etiqueta stderr en el texto. Los mensajes del sistema, avisos y errores usan los roles de color existentes. Conserva la entrada interactiva, EOF y Stop cuando correspondan; no elimines salida parcial ni diagnósticos al mostrar un resultado.

## Memory Viewer

Las regiones se presentan en el orden Static → Stack → Heap. Static y Heap mantienen sus listas y Stack crece horizontalmente hacia la derecha. Los scopes aparecen al entrar en ellos y avanzan de izquierda a derecha desde el más antiguo al más reciente. El scope actual usa el amarillo de `--mark-active`; los scopes antecesores activos usan un tono más pálido. Los scopes que salen pueden conservar su señal temporal mientras se muestran sus objetos eliminados.

Oculta solo el marcador visual del scope raíz de `main` que sirve como punto de entrada. Conserva sus variables, punteros, arrays y structs; conserva también los marcadores y datos de sus scopes anidados y de las demás funciones. La identidad accesible del scope raíz debe seguir disponible aunque no se dibuje su marcador.

El visor mantiene los modos Minimal, Normal y Debug y el historial Anterior/Siguiente. Direcciones y valores usan mono; metadatos mantienen menor jerarquía. Las señales de cambio, destino de punteros, inicialización y salida de scope deben seguir legibles con foco y sin depender solo del color. El tamaño de las celdas y los límites de inspección siguen siendo los definidos por el código y la API del motor.

## Referencias

La guía propia sustituye al registro histórico de px0, que ya no se utiliza.
