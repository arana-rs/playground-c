<img src="assets/icon.svg" width="64" height="64" alt="">

# c-playground-v2

Editor mínimo de C con React, TypeScript y Vite, y un motor propio independiente
para navegador y Node.js. Incluye un ejemplo inicial de Memory Viewer centrado
en punteros asociados a celdas de arrays, cadenas y miembros de structs, además
de un contador de línea y columna del cursor.

El [ejemplo inicial](src/examples/main.c) sigue `p = &a[0]`, el avance `p++` y
la escritura `*p = 99` en una celda de `a`. Luego `q` avanza por la cadena
`"hola"` hasta su celda NUL. Al pasar un puntero o enfocarlo con el teclado, el
visor resalta la celda actual cuando su identidad, offset y tipo coinciden.
`p++` cambia el destino sin cambiar la identidad ni la dirección propia de `p`;
`*p` cambia la celda y no el valor almacenado en el puntero.

Memory Viewer conserva su límite de 10 celdas por array, incluido el NUL, y el
placeholder local para arrays mayores y matrices. Los structs muestran hasta
10 miembros directos como celdas compactas; un array o agregado anidado deja un
placeholder local con su offset y tamaño, mientras que unions y structs mayores
reciben un placeholder global. Normal y Debug muestran direcciones, tipos,
tamaños, offsets y padding con tramos etiquetados; Minimal conserva el nombre
de cada campo y el alias de la variable. Los punteros pueden resaltar la raíz
de un struct compatible o un campo visible por identidad, offset y tipo. Estas
limitaciones son solo visuales y no detienen la ejecución C. El [demo completo
P2–P4](src/examples/p2-p4-full-demo.c) conserva los casos de tipos, control,
arrays, memoria, preprocesador y biblioteca. Ambos archivos se pueden editar y
deshacer normalmente.

El editor colorea palabras clave y tipos, comentarios, números, cadenas,
caracteres, funciones y directivas con la paleta GitHub Dark registrada en px0.
El motor y el editor comparten el escáner de C; el coloreo admite texto incompleto
sin ejecutar ni validar el programa. La selección, el historial y la edición
siguen usando el mismo `textarea`.

El editor completa `()`, `[]`, `{}`, `""` y `''`, rodea el texto seleccionado,
salta los cierres que acaba de generar y borra ambos símbolos con Backspace
dentro de un par vacío. Respeta cadenas, caracteres, comentarios y escapes de C.

Enter conserva la sangría y abre una línea interior dentro de `{}`. Tab indenta
con cuatro espacios y Shift+Tab desindenta; también funcionan sobre selecciones
de varias líneas. Pulsa Escape y después Tab para salir del editor con el teclado.

Ctrl/Cmd+Z deshace y Ctrl/Cmd+Shift+Z rehace (también Ctrl+Y). Cada operación
automática es una acción completa y la escritura consecutiva se agrupa.
Pegar conserva el texto literal; la composición IME se confirma como una sola
acción, sin completar símbolos mientras se está componiendo.

Run ejecuta una copia de `main.c` dentro de un Worker; Stop cancela esa sesión.
El control usa [Button de Arc](https://uiarc.dev/components/button) con
`variant="secondary"` y `size="sm"`, adaptado a 20 px de altura y a la paleta px0.
Los iconos Run/Stop y el texto cambian con la transición de Arc; Stop permanece
habilitado para cancelar, también con el teclado. La animación respeta la
preferencia de movimiento reducido.
La consola muestra `stdout` y `stderr` a medida que el programa los produce.
Cuando C solicita datos por `stdin`, se puede escribir una línea y enviarla con
Enter; el botón EOF cierra la entrada de forma explícita. Las líneas enviadas se
ven una sola vez en la consola. Stop conserva la salida parcial, incluso si la
consola está oculta. El watchdog de 10 segundos cuenta el arranque, la lectura,
la preparación y la ejecución, pero se pausa mientras se espera una respuesta
humana. Al terminar se muestran `exit code: N` o el diagnóstico con archivo,
línea y columna. El footer permanece visible durante la ejecución.

Si vence el watchdog, la consola ofrece copiar un informe JSON versión 1 sin
código fuente ni salida. Incluye tamaño y líneas del archivo, los presupuestos de
Run, contadores que el motor ya había publicado, tiempos medidos al completar
una etapa y valores `null` para los que no llegaron a observarse. Los contadores
de fuente, tokens y preprocesamiento vienen de `prepare`; instrucciones y memoria
son la última captura acumulada de `resume()`. No se suman snapshots entre sí.
`workerTotalMs` y los contadores pueden ser una captura parcial del último marcador recibido.
`lastStage` identifica la última transición recibida; `lastStageObservedMs` mide desde ese
marker en el hilo principal, así que no representa CPU exacta del Worker. El
tiempo desde el envío hasta el primer mensaje incluye arranque y transporte
observables y puede solaparse con la lectura. No sumes esos tiempos; el tiempo
total del hilo principal incluye pausas de `stdin`, mientras que el watchdog las
excluye. Este timeout pertenece a la interfaz; los límites de instrucciones y
memoria del motor siguen siendo diagnósticos de recursos distintos.

El motor `@playground/c11-engine` **0.4.0 implementa parcialmente P4** sobre las
capacidades de P1–P3. Añade preprocesamiento con macros y fases de traducción,
proyectos virtuales con varias unidades de traducción, funciones K&R y variádicas,
`main(argc, argv)`, y subconjuntos de `assert.h`, `ctype.h`, `errno.h`,
`inttypes.h`, `iso646.h`, `stdarg.h`, `stdio.h` y `string.h`. La E/S y los archivos
viven en un sistema virtual que se reinicia en cada ejecución; el core no lee ni
escribe archivos del host. Las familias de lenguaje y headers siguen parciales:
no se afirma conformidad completa con C11.

La API conserva `prepare`/`execute` y `runFile`, y añade `runProject` para
proyectos virtuales con `translationUnits`. `stdout` y `stderr` son `Uint8Array`; la consola los decodifica como UTF-8. `io`
permite configurar `argv`, `stdin` y archivos
semilla virtuales. Las métricas incluyen pasos del preprocesador. La UI usa
límites de 100.000 caracteres, 25.000 tokens, 1.000.000 pasos de preprocesador,
profundidad 128, 100.000 instrucciones, 1 MiB de memoria C y 1 MiB de E/S virtual;
el hilo padre aplica un watchdog de 10 segundos.

El [README del motor](packages/c11-engine/README.md) documenta las entradas
públicas, el sistema virtual de E/S, los resultados y los límites.
La [matriz C11](docs/c11-engine-roadmap.md) distingue **44 familias parciales,
21 pendientes y ninguna completa**; P5 y P6 siguen pendientes.

```sh
pnpm install
pnpm dev
```

Ejecuta un archivo C desde la terminal con el motor propio del proyecto:

```sh
pnpm --silent run-c src/examples/main.c
pnpm --silent run-c src/examples/p2-p4-full-demo.c
```

`run-c` admite una sola fuente por ahora. El archivo del disco se carga como la
unidad virtual `main.c`; los diagnósticos usan ese nombre y los `#include` solo
pueden leer `main.c` y los headers virtuales incorporados por el motor, no
archivos vecinos del disco. La entrada estándar funciona desde una terminal y
mediante una tubería; al esperar `scanf`, la salida acumulada se escribe antes
de leer más entrada. `stdout` y `stderr` del programa se conservan como bytes.
Usa `pnpm --silent` para que los mensajes de pnpm no se mezclen con la salida
del programa en tuberías. Ejecuta `pnpm --silent run-c -- --help` para ver la
ayuda.

Desarrollo local:

```sh
pnpm dev --port 5173
```

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

La referencia visual está en [docs/px0-style-reference.md](docs/px0-style-reference.md).
