# Motor C11: matriz y hoja de ruta

Estado del motor **0.1.0: entrega inicial de P5 implementada parcialmente** en `packages/c11-engine`, con Run/Stop y consola integrados en el editor. La matriz mantiene el alcance completo como hoja de ruta: de las 65 familias —35 del lenguaje, 29 headers y una extensión opcional—, **49 están iniciadas parcialmente, 15 pendientes y una implementada**. P1–P5 tienen capacidades parciales; P6 sigue pendiente. Esto no declara C11 completo ni una fase P5 completa.

## Estado implementado: P5 parcial

P5 añade una primera entrega de nueve áreas de lenguaje: bit-fields y padding, miembros flexibles, `const`/`volatile`/`restrict`, selección `_Generic`, alineación y `_Static_assert`, almacenamiento/linkage/`inline`/`_Thread_local`, declaradores y compatibilidad `typedef`, promociones/conversiones/argumentos y duración/representación/tipo efectivo. La implementación y sus aceptaciones se limitan al perfil x86-64 Linux LP64 descrito abajo. El motor conserva `completeC11: false`; la biblioteca estándar sigue parcial y las áreas pendientes de cada familia no se consideran completas.

El ABI de bit-fields se contrasta con GCC y Clang para SysV x86-64: las unidades se comparten según el layout del perfil, los campos sin nombre de ancho cero actúan como barrera, y un campo `int` simple se trata como firmado según ambos compiladores. Estos detalles de orden, asignación y signedness son decisiones de implementación de este perfil, no reglas universales de C11. Los miembros flexibles ocupan la cola dinámica de la asignación; `sizeof` conserva el tamaño fijo del struct y la asignación de structs no copia la cola. `offsetof` admite rutas de miembros y subíndices constantes, y rechaza bit-fields.

Los tipos calificados se conservan en la semántica y en los nombres de tipo de los DTO; los tipos internos del compilador no forman parte de la API pública. El target admite alineaciones explícitas de potencias de dos hasta 65536 bytes. `malloc` garantiza alineación de 16 bytes; `<stddef.h>` define `max_align_t` con tamaño 32 y alineación 16 en este perfil, cubriendo la alineación fundamental máxima elegida. `_Thread_local` tiene duración propia visible en eventos y snapshots, pero el motor crea una sola instancia por sesión y no implementa concurrencia. Los casts entre puntero y `uintptr_t` pueden recuperar la identidad de direcciones virtuales conocidas/vivas según el perfil.

La evaluación de objetos `volatile` se mantiene en las operaciones del abstract machine del motor; no representa acceso a hardware. `restrict` se conserva y valida en las conversiones cubiertas, pero el motor no promete detector dinámico completo de todas las violaciones de alias ni de UB. La cobertura de tipo efectivo, representación y union punning tampoco implica detección universal de UB. Las aceptaciones positivas y diagnósticos se contrastan con GCC/Clang cuando el perfil comparte su decisión de implementación.

P4 conserva los escalares, expresiones, control, funciones, punteros y objetos de P1–P3. Añade fases de traducción C, trigraphs y continuaciones de línea, UCN, concatenación de literales, macros de objeto/función/variádicas, stringize, token paste, rescaneo, `#undef`, condicionales, includes de archivos virtuales, `#line`, `#error`, pragmas STDC y macros predefinidas publicadas. Cada unidad de traducción prepara su propio estado del preprocesador.

Los proyectos admiten varias unidades de traducción. `static` limita el linkage al archivo y `extern` enlaza declaraciones entre unidades; funciones K&R, `inline`, `_Noreturn`, objetos globales y funciones variádicas se cubren dentro del perfil probado. `main` admite `int main(void)`, `int main()` sin parámetros y el formulario con `argc` y `argv`; la aplicación puede configurar el vector C completo, que termina con un puntero nulo. Las funciones variádicas admiten las promociones predeterminadas y `va_start`, `va_arg`, `va_copy` y `va_end`.

Los 17 headers virtuales se interpretan como subconjuntos; no se leen del host. P4 suma `assert.h`, `ctype.h`, `errno.h`, `inttypes.h`, `iso646.h`, `stdarg.h`, `stdio.h`, `string.h` y un subconjunto de `wchar.h` a los headers numéricos y de memoria anteriores. P5 añade `stdalign.h` y amplía `<stddef.h>` con `offsetof` y `max_align_t`. Las pruebas cubren una selección de macros `PRI`/`SCN`, strings/memoria, clasificación C-locale, conversiones enteras, formatos `printf`/`scanf`, `stdin`/`stdout`/`stderr`, streams y archivos binarios virtuales, EOF, errores, seek y ungetc. `%a`/`%A`, `%L` y `%lc`/`%ls` están cubiertos en `printf`; wide conversions aceptan ASCII en el locale C. Sigue pendiente el scanset wide `scanf %l[` y hay un límite de precisión publicado. Ningún header se declara completo.

Son parciales **L01, L02, L03, L04, L05, L06, L07, L08, L09, L11, L12, L13, L14, L15, L16, L17, L18, L19, L20, L21, L22, L23, L24, L25, L26, L27, L28, L29, L30, L31, L32 y L33**; **L10 (long double binary80)** está implementada. Las 17 familias de biblioteca parciales son **B01, B03, B04, B06, B07, B08, B09, B11, B14, B15, B17, B18, B19, B20, B21, B23 y B28**. Permanecen pendientes 2 familias del lenguaje, 12 headers y Annex K. Las familias parciales retienen capacidades pendientes: entre ellas, compatibilidad y declaradores generales, aliasing/UB que no se detecta por completo, `_Noreturn`, librería matemática y de caracteres anchos completa, locales, `exit`/`atexit`, formatos menos comunes, atomics, threads, VLA, complejos y el resto de las APIs estándar.

La [API y cobertura concreta del paquete](../packages/c11-engine/README.md) están disponibles desde `core`, `browser` y `node`. El core prepara proyectos virtuales y nunca accede al filesystem del host. `runProject` y `runFile` adaptan entradas; cada ejecución reinicia argumentos, entrada, salida, streams y archivos virtuales. Run toma una copia del texto, prepara y ejecuta en un Worker. Stop lo termina; la consola decodifica stdout/stderr y conserva salida parcial en errores o límites.

## Decisiones confirmadas

- Motor propio e incremental, desde cero, local en navegador y reutilizable desde Node.js; modelo de datos x86-64 Linux simulado.
- Antes de implementarlo, definir lenguaje y biblioteca C11 completos como hoja de ruta.
- API pública que acepte `File` en navegador y ruta de archivo en Node.js.
- Medir velocidad del motor: preparación y ejecución separadas.
- Run con límites y cancelación; API con límites configurables para benchmarks.
- Consola: exit code al terminar; diagnóstico ante error de lectura, preparación o ejecución.

El diseño siguiente combina el contrato implementado de P1/P2/P3/P4 con las fases futuras, indicadas como propuestas o pendientes. C11 estricto es el alcance objetivo. POSIX, extensiones GNU, syscalls, ELF, assembly y ejecución de instrucciones x86 requerirían otra hoja de ruta. El perfil Linux no activa esas funcionalidades.

## Perfil de datos implementado y objetivo

El perfil objetivo usa memoria little-endian, bytes de 8 bits y LP64. **P1–P5 implementan los tipos enteros, `float`, `double`, `long double`, punteros, agregados y las alineaciones publicadas en esta tabla; P3 añade contabilidad de objetos virtuales vivos**:

| Tipo | Bits de valor/representación | Tamaño / alineación (bytes) |
| --- | --- | --- |
| `_Bool`, `char` | 8 de almacenamiento | 1 / 1 |
| `short` | 16 | 2 / 2 |
| `int` | 32 | 4 / 4 |
| `long`, `long long` | 64 | 8 / 8 |
| Puntero | dirección virtual de 64 | 8 / 8 |
| `float`, `double` | binary32 / binary64 | 4 / 4; 8 / 8 |
| `long double` · implementado P4 (L10) | x87 binary80: 64 bits de significando y 15 de exponente; almacenado en 16 bytes | 16 / 16 |
| `max_align_t` · perfil P5 | Struct con `long long` y `long double`; `sizeof` elegido 32 | 32 / 16 |

Este destino sigue el [psABI x86-64](https://gitlab.com/x86-psABIs/x86-64-ABI/blob/master/x86-64-ABI/low-level-sys-info.tex) y las opciones de [GCC x86](https://gcc.gnu.org/onlinedocs/gcc/x86-Options.html). El perfil fija `char` firmado, enteros en complemento a dos, conversión a entero firmado fuera de rango mediante low bits y right shift firmado aritmético. `sizeof` devuelve un unsigned de 64 bits. Los enteros se representan con `BigInt`, nunca con `number`; unsigned envuelve módulo 2^N y el overflow aritmético firmado detectado se diagnostica. Los `struct` alinean sus miembros y tamaño final; los `union` ubican miembros en offset cero, también cuando son anónimos. La vista de bytes sigue little-endian. Las alineaciones explícitas aceptan potencias de dos desde 1 hasta 65536 bytes; los allocations heap comienzan alineados a 16 bytes. El ABI de bit-fields está fijado por pruebas diferenciales SysV x86-64 y no pretende ser portable a otros ABI.

Los literales flotantes se redondean directamente al formato de destino; `float` aplica binary32, `double` usa binary64 y `long double` conserva binary80. `FLT_EVAL_METHOD` vale 0; se conservan NaN, infinito, subnormales y cero negativo. Las funciones matemáticas usan `Math` del host sin prometer redondeo correcto universal o igualdad bit a bit entre motores JavaScript. Se elige evaluación de operandos/argumentos izquierda a derecha en los puntos donde C permite un orden no especificado; esto no legaliza accesos sin secuenciar. La cobertura parcial de bit-fields, miembros flexibles, linkage, `offsetof`, `max_align_t` y alineación está descrita en sus filas; locales y familias matemáticas `long double` siguen pendientes. Los registros de CPU no necesitan simularse para este modelo.

El UB que el motor detecte detendrá la ejecución con diagnóstico; no se promete detectar universalmente todo UB. Un resultado dependiente de la implementación debe seguir el perfil publicado; un orden no especificado debe documentar la política elegida sin presentarla como garantía de todo C.

## Fases

P1–P5 tienen entregas parciales; P6 sigue propuesto. Cada fila conserva capacidades pendientes.

| Fase | Entrega | Alcance |
| --- | --- | --- |
| P1 · Implementado | Primer Run | Archivo único; int main(void), variables int, aritmética, bloques, asignaciones y return; diagnósticos, límites, Worker y consola. |
| P2 · Implementado | Cálculo y control | Enteros escalares LP64, promociones/conversiones, float/double básicos, expresiones, ramas, bucles, funciones tipadas, recursión y cinco headers parciales. |
| P3 · Implementado parcialmente | Objetos y memoria | Punteros virtuales, arrays, structs/unions con miembros nombrados y anónimos, enums compatibles con `int`, inicialización, literales de cadena, compound literals, globals y malloc/realloc/free básicos; allocations heap con direcciones virtuales pseudoaleatorias y una vista debug de sus intervalos vivos. `realloc(NULL,n)` actúa como `malloc(n)`; `realloc(p,0)` libera y devuelve `NULL`; una reserva fallida no nula conserva el bloque anterior. P5 amplía parcialmente declarations/linkage, `offsetof` y `max_align_t`; headers completos siguen pendientes. |
| P4 · Implementado parcialmente | Traducción y biblioteca base | Preprocesador y proyectos virtuales parciales, varias unidades, variádicas, stdio, conversiones binary80, formatos `%a`/`%A`, `%L`, `%lc`/`%ls` C-locale ASCII, strings y utilidades base. Las familias siguen parciales donde conservan alcance pendiente. |
| P5 · Entrega inicial parcial | Declaraciones y layout | Nueve áreas de lenguaje, `<stdalign.h>`, `offsetof` y `max_align_t`; C11 completo, bibliotecas completas y resto de familias P5 siguen pendientes. |
| P6 | Capacidades independientes | VLA, complejos, atomics, threads, TLS concurrente y evaluaciones separadas de Annex F/G y Annex K. |

## API y límites entre módulos

Paquete portable implementado como `@playground/c11-engine` 0.1.0 con entradas `core`, `browser` y `node`, JavaScript ESM y declaraciones TypeScript. El core no importa React, DOM, `File`, filesystem ni Worker. Recibe `{entry, files, translationUnits?}`; `files` contiene fuentes y headers virtuales, y por defecto `translationUnits` vale `[entry]`. Los includes quoted buscan junto al archivo actual y en la raíz virtual; los angle buscan en la raíz y los headers virtuales incorporados. Los adaptadores resuelven la interacción con su entorno.

```ts
// core: síncrono; API implementada
prepare(project: SourceProject, options?: PrepareOptions): PrepareResult;
execute(program: PreparedProgram, options?: ExecuteOptions): ExecuteResult;
createExecutionSession(program: PreparedProgram, options?: ExecuteOptions): ExecutionSession;

// browser: lectura y ejecución coordinadas por adaptador
runFile(file: File, options?: RunOptions): Promise<RunResult>;

// node: entrada separada; no arrastrar node:fs al navegador
runFile(path: string, options?: RunOptions): Promise<RunResult>;
```

`PreparedProgram` es inmutable y reutilizable en la misma instancia del core; su representación privada no es transferible a otro Worker. Cada `execute` o `createExecutionSession` abre una sesión nueva de locales, globals, heap y contadores, sin contaminar la siguiente. `prepare` hace lexer → parser → validación del subconjunto → representación interna; `execute` consume esa representación con runtime propio. Una característica pendiente se rechaza con su ubicación y diagnóstico. Cada ejecución también reinicia `stdin`, `stdout`, `stderr`, argumentos, streams y archivos virtuales.

`execute` mantiene semántica por lotes: stdin está completo desde el inicio y su agotamiento, también vacío, es EOF. `createExecutionSession` deja stdin abierto y devuelve un objeto con `resume()`, `appendStdin(bytes)` y `endStdin()`. `resume()` ejecuta el mismo VM hasta terminación, diagnóstico, límite o `{ kind: 'input-needed', stdout, stderr, metrics }`; la salida progresiva es un snapshot acumulado y el VM conserva la pila, los frames, los argumentos evaluados, el estado del parser y las escrituras parciales. Añadir bytes y reanudar continúa esa llamada sin volver a ejecutar efectos. La lista de lectores interactivos está publicada en `CAPABILITIES.interactiveStdinFunctions`: `scanf`, `fscanf`, `getchar`, `getc`, `fgetc`, `fgets` y `fread`; `sscanf` sigue leyendo una cadena finita en modo por lotes. El buffer temporalmente vacío no activa `feof`; `endStdin()` hace sticky el EOF después de los bytes ya almacenados. Los bytes añadidos consumen el presupuesto compartido `maxIOBytes`; un exceso se entrega como el resultado normal `limit` en la siguiente reanudación, con stdout/stderr preservados.

### Debug API · D1: eventos, avance por línea e inspección escalar

Contrato cotejado con los tipos y el runtime del core. La capacidad de observabilidad es transversal al motor: no amplía el lenguaje C, no cambia la matriz de cobertura y no forma parte de P5. `createDebugSession` usa el mismo VM y la misma gestión de objetos; solo la sesión de depuración recolecta eventos y permite inspeccionar escalares, objetos estáticos observados y allocations heap vivas. La sesión normal no crea collector ni pila de frames debug, y conserva su semántica de E/S. La sesión debug siempre toma `main` como entrada, inicializa los globals y sus inicializadores, y avanza hasta entrar en el scope raíz de `main` antes de ejecutar el cuerpo. Conserva el evento `scope-enter` y la pausa inicial de `main`, pero no publica sus variables automáticas futuras. La VM reserva internamente las celdas locales al entrar al scope; `object-create` y la inspección escalar se activan al ejecutar cada declaración, mientras que los parámetros se publican al entrar en su función, antes de su primera instrucción. Esta temporización es debug-only y no cambia la semántica normal de C. Los tipos públicos de depuración se exportan desde `core` y `CAPABILITIES.debugSession` publica el alcance exacto.

```ts
createDebugSession(
  program: PreparedProgram,
  options?: ExecuteOptions,
  debugOptions?: DebugSessionOptions,
): DebugExecutionSession;

interface DebugSessionOptions {
  readonly maxEvents?: number; // presupuesto acumulado; por defecto 100_000
  readonly heapAddressSeed?: number; // aleatoriedad heap reproducible para debug/tests
}

interface DebugExecutionSession {
  resume(): DebugProgress;
  appendStdin(bytes: Uint8Array): void;
  endStdin(): void;
  currentLocation(): DebugSourceLocation | null;
  drainEvents(): readonly DebugEvent[];
  inspectScalars(): readonly DebugScalarSnapshot[];
  inspectStaticObjects(): readonly DebugStaticObjectSnapshot[];
  inspectHeapObjects(): readonly DebugHeapObjectSnapshot[];
}

interface DebugScalarSnapshot {
  readonly id: number; // allocationId del object-create
  readonly scopeId: number;
  readonly frameId: number;
  readonly name: string;
  readonly type: string;
  readonly address: string; // hexadecimal exacto
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string;
}

interface DebugPausedResult extends ExecutionOutput {
  readonly kind: 'paused';
  readonly location: DebugSourceLocation;
  readonly stdout: Uint8Array; // snapshot acumulado
  readonly stderr: Uint8Array; // snapshot acumulado
  readonly metrics: EngineMetrics;
}

interface DebugInputNeededResult extends ExecutionOutput {
  readonly kind: 'input-needed';
  readonly location: DebugSourceLocation; // instrucción C suspendida
  readonly stdout: Uint8Array; // snapshot acumulado
  readonly stderr: Uint8Array; // snapshot acumulado
  readonly metrics: EngineMetrics;
}

type DebugProgress = DebugPausedResult | DebugInputNeededResult | ExecuteResult | DebugLimitResult;
```

`debugOptions` admite `maxEvents` y `heapAddressSeed`; el seed debe ser un entero de 32 bits sin signo. Un objeto `null`, claves desconocidas o valores fuera de esos rangos producen un diagnóstico.

Cada evento tiene `sequence: number`, `kind`, `location` (`{ file, line, column }`) y `frameId`/`scopeId` (`number | null`). `kind` puede ser `frame-enter`, `frame-exit`, `scope-enter`, `scope-exit`, `object-create` u `object-delete`; los eventos de frame incluyen `functionName: string`, y los de scope llevan también `scopeName: string`, asignado desde el AST. El cuerpo de función usa su nombre y un bloque desnudo usa `bloque`. Las etiquetas de control son canónicas y no incluyen sus condiciones: `if(...)`, `while(...)`, `for(...)`, `do { ... } while (...)` y `switch(...)`; `else` conserva `else`. El bloque de un `for` usa `bloque de for`. Un bloque compuesto de control produce una sola activación; los bloques anidados siguen siendo activaciones independientes. `frameId` y `scopeId` identifican, respectivamente, una activación de función y una activación de scope. `location` señala la operación disponible en el runtime; retornos y saltos usan la ubicación de su operación. La salida normal de un bloque informa la ubicación del token `}` conservado por el parser; los scopes cerrados por `return` o salto usan la ubicación de esa transición. `frame-enter` usa la declaración de la función y `frame-exit` usa el `return` explícito o, al caer al final, la llave de cierre del cuerpo. Los eventos correlacionan activaciones, scopes y objetos sin registrar instrucciones ni accesos a valores.

`inspectScalars()` toma una instantánea nueva de las variables aritméticas automáticas ya publicadas y parámetros cuyos frames siguen activos. Una variable local aparece después de ejecutar su declaración; un parámetro aparece al entrar en su función. Incluye `_Bool`, `char`, enteros signed/unsigned, `float`, `double`, `long double` y enums en representación `int`. Los IDs numéricos coinciden con los eventos reales (`id === allocationId`), y `address` convierte la dirección virtual BigInt a hexadecimal. Un objeto indeterminado se entrega como `initialized: false` y `displayValue: '?'`; la consulta no ejecuta una lectura C ni altera memoria, eventos o ubicación. Los enteros y enums se muestran en decimal exacto, `_Bool` como `0`/`1`, char como literal C con escapes, `float`/`double` mediante decimal corto round-trip y `long double` en hexadecimal binary80 exacto, con `-0`, `nan`, `inf` y `-inf` explícitos. Los enums usan el nombre de tipo `int`, como en el modelo actual del motor. Esta inspección no lee arrays, punteros, structs ni unions.

El layout virtual LP64 publicado por `VIRTUAL_MEMORY_LAYOUT` y `CAPABILITIES.virtualMemory` separa Static `[0x10000, 0x20000)`, Stack `[0x20000, 0x30000)` y Heap `[0x30000, 0x40000)`, cada una con 64 KiB nominales. Las direcciones iniciales se alinean a 16 bytes; cada objeto reserva además 16 bytes de guard y el redondeo correspondiente, así que los bytes C efectivos dependen de los allocations vivos. `maxMemoryBytes` cuenta solo bytes C y no amplía estos rangos. Static persiste durante la sesión; Stack usa first-fit ordenado y devuelve los extents al cerrar scope/frame. Su agotamiento produce `STATIC_ADDRESS_SPACE_EXHAUSTED` o `STACK_ADDRESS_SPACE_EXHAUSTED`. El agotamiento de Heap conserva `malloc` devolviendo `NULL` sin diagnóstico de región.

`inspectHeapObjects()` devuelve allocations `malloc` vivas ordenadas por dirección virtual BigInt y serializadas como hexadecimal; cada DTO contiene `id`, `address`, `size` y `origin: 'heap'`, sin inventar nombre, tipo o valor C. `free` elimina el bloque de la vista y libera su intervalo sin mover otros allocations. `CAPABILITIES.virtualMemory.heapAddressRange` publica el intervalo reservado `[0x30000, 0x40000)`, capacidad nominal, alineación de 16 bytes y el guard de 16 bytes que evita que one-past comparta dirección con la base heap siguiente. La selección usa probes pseudoaleatorios acotados y first-fit por extents vivos; el coste de metadata depende del número de bloques, no de los bytes reservados. `heapAddressSeed` hace reproducible el RNG no criptográfico en sesiones debug. La vista queda vacía tras terminación normal; no inspecciona valores tipados de heap.

`currentLocation()` identifica la siguiente posición de fuente que se ejecutará, o devuelve `null` si falla el setup o ya existe un resultado terminal. `drainEvents()` recoge también los eventos emitidos mientras se crea la sesión; se puede llamar antes del primer `resume()` para inspeccionar inicialización y entrada a `main`. Devuelve los eventos desde el drain anterior y no reinicia el contador ni el límite total. `inspectScalars()` está disponible antes de avanzar, durante pausas y después de resultados terminales: tras un retorno normal devuelve `[]`; error/límite conserva solo los objetos vivos en el estado donde se detuvo el VM, sin unwind sintético. El método genera DTO serializables nuevos al solicitarse; el consumidor conserva una copia por pausa si necesita historial. Las instantáneas no consumen `maxEvents`.

`DebugProgress` añade `paused` e `input-needed` a los resultados terminales y al límite propio de depuración. Tanto las pausas como las esperas y resultados terminales llevan snapshots acumulados de `stdout` y `stderr`. `createDebugSession` reutiliza `ExecuteOptions.io` completo: `argv`, bytes iniciales de `stdin` y `files` virtuales, con el mismo `VirtualIO` y despacho stdio de Run. El stdin interactivo queda abierto tras los bytes iniciales; un lector que agota temporalmente su buffer devuelve `input-needed` con la ubicación C suspendida y deja visible el prompt emitido. `appendStdin(bytes)` y `endStdin()` alimentan o cierran la misma sesión; reanudar continúa el generador y la visita de línea conservando argumentos evaluados, conversiones parciales, estado de memoria y efectos, sin volver a ejecutar la instrucción. Una llamada a `resume()` mientras espera devuelve la espera y sus snapshots sin avanzar. `endStdin()` produce EOF sticky después de consumir bytes pendientes. `maxIOBytes` comparte el presupuesto de ejecución usado por Run; `execute()` por lotes conserva EOF al agotar el stdin inicial. Las rutas siguen siendo virtuales y no usan DOM, `File`, `Worker` ni filesystem del host desde el core.

Los eventos de objeto describen raíces de almacenamiento reales del programa: incluyen `objectId`/`allocationId: number`, `duration`, `origin`, `typeSummary: string`, `addressVirtual: bigint` y `size: number`, además de `name?: string` cuando existe. Para cada raíz, `objectId` y `allocationId` contienen el mismo ID y correlacionan creación/eliminación. `duration` distingue `automatic`, `static`, `thread-local`, `heap` y `compound-literal`; `origin` distingue `variable`, `parameter`, `compound-literal`, `heap` y `string-literal`. Los snapshots escalares llevan el mismo `origin` tipado que su evento de creación, de modo que la UI identifica parámetros por metadata del binding. Un array o struct emite una sola raíz: no se crean eventos separados para elementos o miembros ni se fuerza la materialización de subobjetos perezosos. Se incluyen los literales de cadena observables por C; se excluyen objetos de infraestructura como `errno`, `argv` y el almacenamiento interno de `va_list`.

Los objetos con duración automática y los compound literals de bloque pertenecen a una activación y terminan al salir de su scope; los objetos de heap terminan al liberarlos con `free`. En los eventos de creación y eliminación, `frameId`/`scopeId` señalan el dueño del lifetime para esos objetos; son nulos para heap, objetos estáticos, thread-local y literales de cadena. Los objetos estáticos, thread-local y los literales se crean una vez por sesión y no reciben eliminación sintética al terminar el programa. Los objetos automáticos ordinarios se publican al ejecutar su declaración; los parámetros, al entrar en la función. La celda interna puede estar reservada desde que entra su scope, pero no hay `object-create` ni snapshot visible antes de ese punto de ejecución. Un cierre emite `object-delete` solo para una raíz que ya tuvo `object-create`, con el mismo `allocationId`; errores y límites conservan el estado sin unwind sintético. D1 traza solo allocations realizadas por el runtime actual, no es un inventario estático de todas las declaraciones C: los estáticos locales se crean al alcanzar su scope, de modo que una función o bloque no alcanzado no emite ese evento. Los eventos globales pueden emitirse al construir la sesión, antes del primer `resume()`. `drainEvents()` devuelve todo lo acumulado desde el drain anterior, en orden de secuencia.

El presupuesto `maxEvents` cuenta todos los eventos de la sesión y no se reinicia al drenar. Si se excede, la sesión devuelve el resultado de depuración `kind: 'debug-limit'`, `resource: 'maxDebugEvents'`, con `limit`, `diagnostics`, `metrics` y los snapshots de salida acumulados; conserva el prefijo emitido y no descarta eventos silenciosamente. El límite se comprueba antes de mutar el estado que produciría el evento excedente. Este resultado pertenece a `DebugProgress` y no amplía `ExecuteResult` ni `LimitResource` de las sesiones normales.

### Debug API · D1 (etapa 2): avance por línea

Cada `resume()` ejecuta la visita actual de línea y pausa con `kind: 'paused'` antes de la primera instrucción ubicada en otro archivo o línea. Las instrucciones contiguas de la misma línea forman una visita; las llamadas avanzan dentro de la función llamada. Si durante un mismo `resume()` se reingresa al mismo PC en el mismo frame, se pausa antes de repetirlo, lo que permite avanzar por bucles y `goto` que vuelven a la misma línea. `location` y `currentLocation()` señalan la posición siguiente, antes de ejecutar su instrucción.

D1 informa creación y eliminación de frames, scopes y objetos, permite avanzar por línea e inspeccionar escalares automáticos, objetos estáticos o thread-local observados, arrays, structs, punteros y allocations heap activas. `inspectArrays()` devuelve raíces con metadata y celdas por elemento para arrays unidimensionales de tipos aritméticos y literales de cadena observados. `inspectAggregates()` devuelve structs/unions automáticos y estáticos, además de vistas efectivas tipadas de agregados heap. Publica hasta 10 miembros directos por struct: cada miembro aritmético o puntero incluye su estado; los bit-fields incluyen ancho, offset de bit y unidad de almacenamiento compartida; los miembros flexibles indican tamaño de elemento, capacidad y longitud real; si contienen elementos aritméticos, incluyen celdas con los mismos límites y truncación que los arrays. Arrays y agregados anidados conservan placeholders con offset y tamaño. Un union o struct que supera ese límite mantiene un placeholder global. En snapshots heap, `rootId` identifica la asignación y `viewId` distingue subobjetos tipados; dirección y tamaño describen el rango de la vista. `inspectPointers()` devuelve snapshots de objetos puntero con su propia identidad y dirección, estado de inicialización, valor almacenado y, cuando existe, la identidad y el offset de su destino. El destino no incluye una dirección ni un valor leído, no recorre grafos y no altera el estado C. `DebugSessionOptions` acota los roots con `maxObjects` y las celdas con `maxElementsPerArray`; el límite de miembros directos es 10. Si una raíz array no admite celdas, conserva su descriptor/status. `omittedObjects` cuenta los roots omitidos por cada inspector.

En la aplicación, Memory Viewer consulta snapshots de `inspectScalars()`, `inspectStaticObjects()`, `inspectArrays()`, `inspectAggregates()` e `inspectPointers()` después de cada `resume()` y conserva esos estados para navegar con Anterior/Siguiente. Para una misma identidad de objeto, marca un cambio cuando difiere `initialized` o `displayValue`; también detecta cambios de estado o destino en punteros miembro. Una escritura mediante `*p` puede cambiar el escalar, la celda o el miembro destino mientras la dirección almacenada en `p` permanece igual. Para un valor indeterminado, el DTO conserva `displayValue: '?'`; la tarjeta del visor muestra `—`, sin texto auxiliar en Minimal y con “Sin inicializar” en Normal/Debug. Anterior/Siguiente recorre snapshots ya capturados: no revierte la VM ni vuelve a ejecutar escrituras.

La captura tiene granularidad por visita de línea. `resume()` agrupa las instrucciones contiguas de una línea y entrega el estado al terminar esa visita; si una línea escribe el mismo objeto varias veces, el snapshot conserva solo el resultado final de la línea. La vista representa los valores posteriores a cada pausa, no una traza de cada escritura ni el operador que la produjo. Para ver mutaciones separadas, cada operación debe estar en una línea distinta.

### Memory Viewer · arrays y literales de cadena

Memory Viewer muestra arrays unidimensionales en su región (Stack o Static / TLS) como un bloque contiguo, con una celda por elemento y su índice. TLS usa la región estática de la sesión única, conserva `duration: 'thread-local'` y aparece con esa etiqueta accesible. Los literales de cadena se representan únicamente por sus celdas, sin una vista previa textual duplicada; el NUL se muestra como `\0` en Minimal, Normal y Debug. En Minimal, los índices de array aparecen al pasar el puntero o recibir foco de teclado accesible; en Normal y Debug siempre están visibles.

Se muestran hasta 10 celdas reales por array, contando el NUL y los ceros de relleno. Un array mayor recibe el placeholder local «Máximo 10 elementos»; las matrices reciben una degradación local informativa. Ninguno de esos casos limita o detiene la ejecución C. Por ahora se conserva este límite visual; ampliar arrays mayores y matrices sigue pendiente.

### Memory Viewer · structs, unions y padding

Un struct se muestra en su región Stack o Static / TLS como un bloque para sus miembros directos; también se muestran vistas tipadas de structs heap cuando el runtime puede asociar el tipo efectivo a una asignación. Se conservan hasta 10 miembros: los campos aritméticos y punteros muestran valores y estados, y los campos array o agregado anidado usan un placeholder local que mantiene el nombre, offset, dirección y tamaño. Los bit-fields muestran su rango de bits y el tamaño de su unidad compartida; no se les asigna un rango de bytes exclusivo que se solape falsamente con otros campos. Un miembro flexible conserva el offset fijo y muestra su longitud y capacidad dinámica. Un union o struct con más de 10 miembros usa un placeholder global. Ninguna de esas presentaciones limita ni detiene la ejecución C.

Minimal mantiene el nombre de cada campo siempre visible y el alias del objeto debajo del bloque. Normal y Debug enseñan la dirección raíz y la de cada campo, tipo, tamaño, offset y los rangos reales de padding interno o final. El padding usa etiquetas con sus offsets y tamaños; no se dibuja como una escala proporcional a bytes. Los snapshots por visita de línea se guardan en el historial, así Anterior/Siguiente restaura valores, estados inicializados y marcas `Δ` sin reejecutar el VM.

Los punteros miembro reutilizan el foco y hover de los punteros escalares y distinguen sin inicializar, NULL, vivo, one-past, colgante y no mapeado. Cuando el destino visible coincide por allocationId, offset y tipo, se resalta una raíz struct compatible o el campo exacto; un `struct S *` a la raíz no se confunde con un puntero primitivo al primer campo, aunque ambos usen offset cero. No se expanden miembros anidados ni se siguen punteros para recorrer grafos.

### Memory Viewer · punteros y celdas de arrays

El visor muestra los objetos puntero escalares y distingue su almacenamiento de la dirección guardada: `address` es la dirección propia del objeto puntero y `displayValue` presenta su valor actual, como `0x...`, `0x0` o `?`. `target` conserva la identidad de la asignación y el offset de bytes cuando el destino se puede identificar. El puntero sin inicializar y el puntero nulo tienen estados distintos.

Pasar el puntero o enfocarlo con el teclado resalta un escalar o una celda de array cuando su asignación sigue viva. Para arrays, la celda se resuelve por `allocationId === rootId`, offset de bytes exacto y tipo; el cálculo usa las direcciones virtuales enteras sin perder precisión. No se enlaza comparando solo direcciones visibles. `p++` conserva la identidad y dirección propia de `p` y mueve su destino a la siguiente celda. Una escritura mediante `*p` marca el cambio de la celda y deja intacto el snapshot del puntero. En cadenas, `char *q = texto` y `q++` enlazan cada carácter, incluido `\0`. Anterior/Siguiente restaura cada relación y valor desde el historial inmutable, sin volver a ejecutar C.

Solo se resuelven destinos con identidad y celda visibles: one-past, offsets desalineados, punteros colgantes, IDs sin raíz viva y arrays placeholder no reciben vínculo. Los escalares conservan el vínculo por identidad de raíz y offset cero. El límite de 10 celdas y el placeholder de matrices descritos arriba se mantienen.

El alcance actual incluye punteros a celdas de arrays unidimensionales disponibles y literales/cadenas de hasta 10 celdas visibles, además de raíces struct compatibles y sus campos directos visibles. Las vistas de heap solo sustituyen el bloque raw cuando cubren exactamente la asignación; una subvista o vista desfasada deja visible el bloque raw completo para conservar bytes fuera de ella. Las celdas de arrays mayores y matrices, sub-vistas parciales de heap, miembros anidados no admitidos, punteros a función y grafos de referencias no tienen vínculo visual.

La presentación sigue los valores C por elemento y no inventa terminadores. `int a[4] = {10, 20}` se presenta como `10, 20, 0, 0`; `char texto[5] = "hola"` como `h, o, l, a, \0`; y `char raw[3] = "abc"` es válido sin `\0`. Para automáticos sin inicializador, cada celda conserva `initialized: false`: Minimal muestra `—` sin leyenda y Normal/Debug añade “Sin inicializar”. La inicialización parcial deja en cero los elementos omitidos. `char texto[] = "abcdefghij"` tiene 11 celdas incluido el NUL y recibe el placeholder por superar el límite.

El historial conserva snapshots inmutables por visita de línea y Anterior/Siguiente los restaura sin revertir ni reejecutar el VM. `Δ` se marca solo en la celda cuyo valor o estado de inicialización cambió; las operaciones que deban verse por separado han de estar en líneas distintas. El límite de inspección y el placeholder no cambian el estado del programa, y las direcciones usan las conversiones LP64 existentes.

Resultados discriminados implementados:

- `prepared`: programa listo; resultado interno de preparación.
- `terminated`: `exitCode`, `rawExitStatus` y `mainReturn` cuando corresponde.
- `read-error` / `prepare-error` / `runtime-error`: diagnósticos de su etapa.
- `limit`: recurso y límite alcanzado; `cancelled`: cancelación externa.

En terminación normal, el perfil Linux expone `exitCode` entre 0 y 255, conservando el status original: retornar 256 desde `main` da `mainReturn: 256`, `rawExitStatus: 256`, `exitCode: 0`. Error, límite o cancelación no fabrican un exit code exitoso. Cuando se implementen `exit(status)`, `abort` y señales, se conservará el status de `exit` sin inventar un retorno de `main`, y la terminación anormal mantendrá su categoría y diagnóstico. [Linux exit(3)](https://man7.org/linux/man-pages/man3/exit.3.html).

## Rendimiento y cancelación

Los adaptadores ya publican `readMs`, `prepareMs`, `executeMs` y `totalMs`. Lectura/decodificación pertenecen a `readMs`; crear y reiniciar la sesión pertenece a `executeMs`; `totalMs` mide la llamada completa al adaptador. El core separa preparación y ejecución, junto con caracteres, tokens, instrucciones y máximo almacenamiento virtual. Arranque, comunicación y terminación del Worker quedan fuera de esas medidas y pueden medirse desde el hilo padre como un tiempo adicional.

Ya es posible preparar una vez y llamar `execute` repetidamente con sesiones independientes; el README del paquete incluye un ejemplo. Un helper dedicado de benchmark con calentamiento y muestras sigue siendo trabajo futuro. El tracing y los callbacks por instrucción también son futuros; la Debug API emite eventos de ciclo de vida y snapshots escalares cuando se solicitan.

P4 ofrece límites configurables de caracteres, tokens, pasos del preprocesador y profundidad en preparación, y de instrucciones, memoria C, E/S virtual y profundidad en ejecución. La UI usa **100.000 caracteres, 25.000 tokens, 1.000.000 pasos del preprocesador, profundidad 128 por etapa, 100.000 instrucciones, 1 MiB de memoria C, 1 MiB de E/S virtual y watchdog de 10 segundos** desde el padre del Worker. Son presupuestos iniciales publicados, no umbrales declarados óptimos. Los valores por defecto del core se exportan aparte como `DEFAULT_PREPARE_LIMITS` y `DEFAULT_EXECUTE_LIMITS`; la API admite enteros seguros no negativos y desactivación explícita mediante `null` para benchmarks. Durante una sesión interactiva, `executeMs` acumula el tiempo síncrono de setup y cada `resume()`, sin incluir la espera humana; el Worker pausa el watchdog de ejecución mientras espera stdin y lo reactiva al recibir una línea. Stop termina el Worker y descarta la sesión. `maxMemoryBytes` limita y `peakMemoryBytes` resume los bytes de objetos C vivos: parámetros, locales, globals y objetos estáticos, literales de cadena y heap; no equivalen al consumo de memoria del proceso JavaScript. Las pilas explícitas permiten recursión profunda sin consumir la pila de llamadas del host; los bucles y la recursión infinitos se detienen al agotar presupuestos.

La UI ya prepara y ejecuta en Worker. El hilo padre lo termina al pulsar Stop o vencer el watchdog. Los adaptadores aceptan `AbortSignal` y comprueban cancelación antes y después de la lectura y entre etapas. El core síncrono comprueba presupuestos en puntos definidos: un `AbortSignal` nuevo no puede interrumpirlo si el mismo hilo está ocupado y no procesa eventos. El adaptador de Node todavía no crea un Worker; el consumidor puede integrarlo para cancelación activa. `execute` directo sigue siendo síncrono y limitado por presupuestos. Cancelar descarta la sesión, preserva el texto y permite el siguiente Run.

P4 introduce puertos virtuales para stdin/stdout/stderr y archivos. `maxIOBytes` limita de forma separada la entrada, salida y contenido residente del filesystem virtual; el reloj, entorno, señales y las familias restantes siguen futuros. La interfaz decodifica las salidas de bytes como texto UTF-8. En modo interactivo publica el snapshot antes de esperar más datos; la aplicación calcula y muestra el delta. El core solo recibe bytes UTF-8 o bytes directos y no importa DOM, Worker, decodificadores ni callbacks de la aplicación.

## Matriz del lenguaje

**32 familias parciales**, enumeradas en «Estado implementado: P5 parcial»; las otras **2 familias del lenguaje pendientes**. Ninguna familia completa. Las columnas siguientes describen el alcance objetivo y aceptaciones propuestas, incluidas capacidades que todavía se rechazan; la tabla no implica que una familia parcial ya esté completa. Cada aceptación es un ejemplo mínimo y no basta para demostrar conformidad. Inventario contrastado con [WG14 N1570, §§5–6](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf).

| ID | Área y alcance | Fase | Aceptación mínima propuesta |
| --- | --- | --- | --- |
| L01 | Entrada, terminación y main con argv | P1→P4 | `main(void)`, `main()` sin parámetros y `main(argc, argv)`; el vector acaba en NULL. |
| L02 | Diagnósticos, restricciones y comportamiento | P1→P6 | Sintaxis inválida ubica archivo/línea; overflow firmado detectado detiene la sesión. |
| L03 | Lexer: tokens, UCN, escapes, trigraphs y concatenación | P1→P4 | Comentario, continuación de línea y literales concatenados conservan procedencia. |
| L04 | Includes y condicionales | P2→P4 | Header numérico virtual en P2; #if defined(X) y includes generales en P4. |
| L05 | Macros: argumentos, variádicas, #, ## y rescaneo | P4 | Macro anidada expande una vez correctamente; #undef elimina la definición. |
| L06 | Procedencia, predefinidas y pragmas STDC | P4→P6 | #line, #error, _Pragma, __FILE__/__LINE__ y capacidades verificables. |
| L07 | Nombres, typedef, declaradores y tipos compatibles | P1→P5 | Declaradores anidados, arrays/funciones ajustados, typedef repetido del mismo tipo y composites entre declaraciones; tipos incompatibles diagnosticados. |
| L08 | Enteros, _Bool y literales LP64 | P1→P2 | 9007199254740993ULL exacto; wrap unsigned; tamaños del perfil. |
| L09 | float/double, literales decimales y hexadecimales | P2 | (float)16777217 redondea a 16777216; ±0, NaN e infinito se preservan. |
| L10 | long double binary80 | P4 | `sizeof(long double)==16`; `1.0L+0x1p-63L != 1.0L`; almacenamiento binary80 y alineación de 16 bytes. |
| L11 | Promociones, conversiones, casts y argumentos | P1→P5 | Default promotions de argumentos sin prototipo/variádicos, tipos de parámetros ajustados y conversions signed/unsigned; `int f()` frente a `int f(void)`. |
| L12 | Unarios, prefijo/postfix y acceso | P1→P3 | Cubrir + - ! ~ & * [] . -&gt; () con objetos/funciones; distinguir ++i de i++. |
| L13 | Aritmética, bits y comparaciones | P1→P2 | -7/3==-2; resto, shifts, & ^ \| y comparaciones con extremos. |
| L14 | Cortocircuito, ternario, coma y secuenciación | P2 | 0&&f() no llama f; ?: elige una rama; coma ordena efectos. |
| L15 | Lvalues y asignaciones simples/compuestas | P1→P2 | a[i++] += 2 calcula el destino una sola vez. |
| L16 | Bloques, if/else y switch | P1→P2 | Scope local, fallthrough y default producen el resultado esperado. |
| L17 | for, while y do | P2 | Declaración en for y continue respetan condición e incremento. |
| L18 | Etiquetas, goto, break, continue y return | P1→P2 | Salto a etiqueta válido; cruces de scope restringidos diagnosticados. |
| L19 | Llamadas, parámetros, frames y recursión | P1→P3 | Factorial recursivo; valores independientes; llamada por puntero tipado. |
| L20 | Prototipos y definiciones antiguas válidas en C11 | P2→P4 | Prototipos tipados/incompatibles en P2; definición K&R válida en P4. |
| L21 | Funciones variádicas | P4 | va_start/arg/copy/end; float→double y promociones de enteros pequeños. |
| L22 | Punteros virtuales, aritmética y conversiones | P3 | Nulo, void*, desplazamiento, resta y one-past en el mismo array; acceso fuera de objeto falla. |
| L23 | Objetos, duración, representación y tipo efectivo | P1→P5 | Duración automática, estática, heap y TLS por sesión; bytes little-endian, copy/effective-type observables y uso tras free diagnosticado, sin detector universal de UB. |
| L24 | Arrays, strings y decay | P3 | Array multidimensional; sizeof conserva tipo; literal de cadena incluye NUL y no es modificable. |
| L25 | Structs/unions y miembros anónimos | P3 | Copiar, pasar y retornar agregados; acceso . y -&gt; a miembros nombrados y promovidos desde struct/union anónimo. |
| L26 | Enums y expresiones constantes | P3 | Valores explícitos e implícitos compatibles con `int`; expresión constante entera aceptada dentro del rango `int`, valor no constante o fuera de rango rechazado. |
| L27 | Padding, bit-fields y miembro flexible | P5 parcial | Unidades, padding, barrera de ancho cero, extracción/signo y FAM final contrastados con GCC/Clang SysV x86-64; `sizeof` y asignación omiten la cola dinámica. |
| L28 | Inicialización y designadores | P1→P3 | Ceros omitidos, arrays/agregados anidados, brace elision, .campo y [índice]. |
| L29 | Compound literals | P3 | Dirección estable dentro del bloque y duración estática al nivel global. |
| L30 | const, volatile y restrict | P5 parcial | Asignación a lvalue const rechazada, casts respetan el tipo del objeto original, qualifiers preservados y evaluación volatile; no hay detector total de alias UB por `restrict`. |
| L31 | Almacenamiento, linkage, inline, _Noreturn y _Thread_local | P4→P6 | `extern` de bloque, linkage y external inline C11 entre unidades, TLS serializada por sesión; independencia por hilo y `_Noreturn` siguen pendientes. |
| L32 | sizeof, _Alignof, _Alignas y _Static_assert | P2→P5 | Alineación explícita hasta 65536 (heap 16), `max_align_t` de 32/16 en el perfil, `offsetof` anidado y ICE válidas; expresiones no-ICE rechazadas. |
| L33 | _Generic | P5 parcial | Compatibilidad de tipo, lvalue conversions y asociaciones no evaluadas; selección correcta en expresiones y contextos de constante entera. |
| L34 | VLA y complejos: capacidades separadas | P6 | sizeof dinámico de VLA; cálculo _Complex; _Imaginary se evalúa aparte. |
| L35 | _Atomic y modelo de memoria concurrente | P6 | Load/store, RMW, CAS y órdenes; scheduler virtual y carreras detectables. |

## Matriz de biblioteca estándar

Los 29 headers de C11 aparecen en el inventario como familias de alcance completo. P1–P3 iniciaron parcialmente **B06 (`float.h`), B09 (`limits.h`), B11 (`math.h`), B17 (`stdbool.h`), B18 (`stddef.h`), B19 (`stdint.h`) y B21 (`stdlib.h`)**. P4 añade **B01 (`assert.h`), B03 (`ctype.h`), B04 (`errno.h`), B07 (`inttypes.h`), B08 (`iso646.h`), B15 (`stdarg.h`), B20 (`stdio.h`), B23 (`string.h`) y B28 (`wchar.h`)**. P5 suma **B14 (`stdalign.h`)** como familia parcial. Quedan **12 headers pendientes**. Ningún header se declara completo. Las aceptaciones siguientes describen el objetivo de cada familia, incluidos elementos todavía rechazados. [WG14 N1570, §7](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf).

| ID | Área y alcance | Fase | Aceptación mínima propuesta |
| --- | --- | --- | --- |
| B01 | &lt;assert.h&gt; · aserciones | P4 | assert verdadero continúa; falso termina anormalmente con diagnóstico; NDEBUG lo desactiva. |
| B02 | &lt;complex.h&gt; · familias complejas | P6 | cabs(3+4*I)==5; variantes float/double/long double y dominios. |
| B03 | &lt;ctype.h&gt; · clasificación y transformación | P4→P5 | EOF y unsigned char válidos; toupper y clasificación bajo locale definido. |
| B04 | &lt;errno.h&gt; · errores de biblioteca | P4→P6 | Conversión fuera de rango fija ERANGE; errno independiente por hilo en P6. |
| B05 | &lt;fenv.h&gt; · entorno flotante | P5→P6 | Guardar/restaurar entorno, consultar flags y redondeo; Annex F se valida aparte. |
| B06 | &lt;float.h&gt; · límites flotantes | P2→P5 | Radix 2; mantisas 24/53/64; macros LDBL_* concuerdan con binary80; FLT_EVAL_METHOD corresponde a la evaluación real. |
| B07 | &lt;inttypes.h&gt; · formatos y conversiones anchas | P4 | PRI/SCN macros y strtoimax preservan el extremo de 64 bits. |
| B08 | &lt;iso646.h&gt; · operadores alternativos | P4 | and, or y not expanden a sus operadores y respetan precedencia. |
| B09 | &lt;limits.h&gt; · límites enteros | P2→P4 | CHAR_BIT==8 y LONG_MAX exacto; constantes tienen los tipos correctos. |
| B10 | &lt;locale.h&gt; · locales virtuales | P5 | setlocale/localeconv; estado C inicial y datos de locale reproducibles. |
| B11 | &lt;math.h&gt; · familias f/d/ld y clasificación | P2→P6 | sqrt, fmod, fma, clasificación y errores; variantes `long double` y Annex F siguen aparte. |
| B12 | &lt;setjmp.h&gt; · salto no local | P5 | setjmp devuelve 0; longjmp vuelve con 7 y restaura el frame válido. |
| B13 | &lt;signal.h&gt; · señales virtuales | P5 | signal registra handler; raise lo invoca; terminación anormal queda identificada. |
| B14 | &lt;stdalign.h&gt; · macros de alineación | P5 parcial | `alignas`/`alignof` aliasan `_Alignas`/`_Alignof`; macros de disponibilidad valen 1. |
| B15 | &lt;stdarg.h&gt; · recorrido de varargs | P4 | va_copy mantiene recorrido independiente y va_end cierra ambos. |
| B16 | &lt;stdatomic.h&gt; · operaciones y fences | P6 | CAS, fetch_add, atomic_flag y órdenes bajo scheduler reproducible. |
| B17 | &lt;stdbool.h&gt; · macros booleanas | P2→P4 | bool b=9 normaliza a 1; true/false y macro de disponibilidad correctos. |
| B18 | &lt;stddef.h&gt; · tipos, NULL y offsetof | P3→P5 parcial | Ofrece `NULL`, `size_t`, `ptrdiff_t`, `wchar_t`, `offsetof` para miembros y subíndices constantes, y `max_align_t` alineado al perfil; la familia restante sigue parcial. |
| B19 | &lt;stdint.h&gt; · tipos exactos/least/fast y límites | P2→P4 | int64_t y UINT64_C exactos; intptr_t representa la dirección virtual. |
| B20 | &lt;stdio.h&gt; · FILE, formatos, buffers y archivos virtuales | P4→P5 | `printf`/`scanf` parciales, `%a`/`%A`, `%L`, wide ASCII de C locale, EOF/error, lectura binaria, seek y ungetc; API y formatos restantes siguen pendientes. |
| B21 | &lt;stdlib.h&gt; · memoria, conversión, sort, RNG y entorno | P3→P5 | `NULL`, `size_t`, malloc/realloc/free; `realloc(p,0)` libera y devuelve `NULL`; strtol, qsort, rand, multibyte, atexit/exit y entorno virtual después. |
| B22 | &lt;stdnoreturn.h&gt; · macro noreturn | P5 | noreturn corresponde a _Noreturn; validar declaración y uso. |
| B23 | &lt;string.h&gt; · bytes, strings y colación | P4→P5 | memmove solapado, strcmp, strtok y strxfrm bajo locale virtual. |
| B24 | &lt;tgmath.h&gt; · selección matemática por tipo | P6 | Seleccionar real/complejo y precisión correcta sin evaluar argumentos dos veces. |
| B25 | &lt;threads.h&gt; · hilos, mutex, condición y TSS | P6 | Dos hilos, join, mutex/cnd, call_once y destructor TSS; sin carreras ocultas. |
| B26 | &lt;time.h&gt; · reloj y calendario | P5 | Fuente temporal virtual, timespec_get, difftime, mktime y strftime deterministas. |
| B27 | &lt;uchar.h&gt; · conversiones char16_t/char32_t | P5 | mbrtoc16/32 y c16/32rtomb con mbstate; secuencia inválida diagnosticada. |
| B28 | &lt;wchar.h&gt; · texto ancho, streams y multibyte | P4→P5 | P4 declara `wchar_t`, `wint_t`, `WEOF` y convierte `%lc`/`%ls` ASCII bajo locale C; conversiones con estado, streams, scanset wide y demás APIs quedan pendientes. |
| B29 | &lt;wctype.h&gt; · clasificación ancha | P5 | wctype/wctrans, iswalpha y towupper conforme al locale seleccionado. |

### Extensión opcional

| ID | Área y alcance | Fase | Aceptación mínima propuesta |
| --- | --- | --- | --- |
| O01 | Annex K · interfaces con límites y constraint handlers | P6 · opcional | Solo anunciar tras cubrir contratos y fallos; __STDC_LIB_EXT1__ y opt-in coherentes. |

## Capacidades y validación

VLA, complejos, atomics y threads se anuncian por separado. Sus macros `__STDC_NO_VLA__`, `__STDC_NO_COMPLEX__`, `__STDC_NO_ATOMICS__` y `__STDC_NO_THREADS__` deben reflejar la versión implementada. `_Thread_local` tiene trabajo propio en L31: no equivale a implementar `<threads.h>`. Annex F/G —`__STDC_IEC_559__` y `__STDC_IEC_559_COMPLEX__`— requieren evaluación adicional; Annex K es opcional. Durante fases parciales se publica cobertura del motor, sin anunciar conformidad hosted/freestanding ni macros de conformidad completas. [WG14 N1570, §6.10.8.3 y anexos F/G/K](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf).

Una fila se completa cuando cubre toda su familia, dependencias, casos límite y diagnóstico, no cuando pasa el ejemplo de la tabla. Mantener pruebas unitarias propias y diferenciales frente a GCC/Clang con `-std=c11 -pedantic-errors`; usar ejemplos sin UB y evitar exigir igualdad cuando C admite varios órdenes o resultados. GCC distingue su dialecto GNU del estándar seleccionado. [GCC Standards](https://gcc.gnu.org/onlinedocs/gcc/Standards.html).

Añadir pruebas de extremos numéricos, memoria/lifetime, procedencia, límites, cancelación y reinicio entre sesiones; cada fase debe probarse en navegador y Node. La cobertura, perfil y resultados de validación tendrán versión pública. “C11 completo” quedará reservado a una cobertura y validación suficientes.

## Primer hito implementado: P1

```c
int main(void) {
    int x = 6;
    return x * 7;
}
```

El hito ya devuelve `exitCode: 42` tanto desde `File` como desde ruta, permite reutilizar el preparado sin conservar estado, diagnostica características pendientes y detiene presupuestos agotados. Se mantiene como regresión del primer Run; su aceptación por sí sola no completa ninguna familia.

En la app ya hay un botón compacto **Run** en la barra de `main.c`; durante ejecución cambia a **Stop**. La consola está debajo del editor, con separador fino y footer `Ln N Col N` visible. Muestra `stdout`, `stderr` y el código de salida al terminar, o un diagnóstico con archivo/línea/columna. Al pulsar Run toma una copia del contenido para que la edición posterior no altere esa sesión.

## Hito implementado: P2

```c
#include <stdint.h>
#include <math.h>

long factorial(int n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}

int main(void) {
    uint64_t exact = 9007199254740993ULL;
    int sum = 0;
    for (int i = 1; i <= 6; ++i) sum += i;
    return exact - 9007199254740992ULL == 1
        && factorial(10) == 3628800L
        && sqrt(81.0) == 9.0 && sum == 21;
}
```

El ejemplo termina con `exitCode: 1`. P2 se valida con regresiones P1, pruebas de extremos numéricos y promoción, redondeo, flujos y scopes, conversión de parámetros/retornos, recursión profunda, límites, diagnósticos y reinicio de sesiones. Los oráculos GCC y Clang usan programas fijos, finitos y sin UB con `-std=c11 -pedantic-errors`; no ejecutan texto del editor en el host. Los casos de UB detectado y elecciones no portables del perfil se verifican en pruebas separadas.

## Hito implementado parcialmente: P3

P3 añade direcciones y punteros virtuales LP64, punteros a función tipados, conversión de punteros a objetos con `void *`, aritmética/diferencia limitada al mismo array, one-past y diagnósticos de acceso fuera de límites, null, liveness y `free` inválido. Implementa arrays multidimensionales y decay, layout/copia/paso/retorno de structs y unions con miembros nombrados y anónimos, enums compatibles con `int` mediante expresiones constantes enteras de rango `int`, designadores recursivos, brace elision y cero-fill. Los literales de cadena incluyen NUL y son de solo lectura; los compound literals admiten duración automática de bloque y estática de archivo. Los globals se reinician al comenzar cada ejecución. `maxMemoryBytes` y `peakMemoryBytes` suman todos los bytes virtuales vivos de parámetros/locales, globals/estáticos, cadenas y heap.

La biblioteca parcial incluye `<stddef.h>` con `NULL`, `size_t`, `ptrdiff_t`, `offsetof` y `max_align_t`, y `<stdlib.h>` con `NULL`, `size_t`, `malloc`, `realloc` y `free`. Este perfil elige que `malloc(0)` y `realloc(p, 0)` devuelvan `NULL`; `realloc(p, 0)` libera `p`, mientras que un fallo normal de reserva conserva el bloque anterior. `realloc(NULL, n)` se comporta como `malloc(n)`. `max_align_t` tiene tamaño 32 y alineación 16 en el perfil P5. P4 añade `static` local y varias unidades con enlace de ámbito de archivo; P5 agrega block `extern`, external inline C11 y TLS base, pero el área conserva alcances pendientes. Bit-fields y miembros flexibles tienen soporte parcial en L27/P5. Strings en esta fase son literales y arrays de `char`: las funciones de `string.h` siguen parciales en P4→P5.

El [ejemplo inicial](../src/examples/main.c) recorre un puntero por un array, modifica una celda con `*p` y avanza un puntero de caracteres hasta el NUL de una cadena. Los arrays mayores de 10 elementos y matrices conservan sus placeholders locales; unions y structs con más de 10 miembros usan placeholders globales, y los miembros anidados no admitidos conservan placeholders locales. Estas vistas no detienen el programa. El [demo P2–P4](../src/examples/p2-p4-full-demo.c) conserva los casos completos de tipos, control, memoria, preprocesador y biblioteca. La matriz permanece abierta hasta completar y validar cada familia.


## Hito implementado parcialmente: P4

P4 añade traducción por unidades virtuales, macros y directivas, funciones K&R y variádicas, `main(argc, argv)` y una biblioteca C parcial. La cobertura comprobada incluye argumentos y salida por bytes, `printf`/`snprintf` y `scanf`/`sscanf`, `%a`/`%A`, conversiones `%L` binary80, `%lc`/`%ls` ASCII bajo locale C, streams/archivos virtuales, assert, clasificación C-locale, errno, inttypes y funciones básicas de strings/memoria. Los errores de conversión wide no representable fijan `EILSEQ`; el scanset wide `scanf %l[` sigue pendiente. Los headers se suministran como código C virtual; el core no busca archivos del host.

`SourceProject` admite `translationUnits`; `ExecuteOptions.io` admite `argv`, `stdin` y archivos iniciales. Cada ejecución tiene un entorno de E/S nuevo, y el presupuesto `maxIOBytes` comparte capacidad entre entradas, salida y archivos residentes. La UI decodifica stdout/stderr y usa un límite de 1 MiB de E/S y 1.000.000 pasos de preprocesamiento. El paquete fija 5.000.000 pasos por defecto para el core.

P4 fue un incremento parcial y P5 añade una entrega inicial parcial: las familias de lenguaje y biblioteca conservan capacidades pendientes, salvo L10 binary80 implementada. Las suites de aceptación no demuestran conformidad C11 completa; P6 y las capacidades restantes de P5 —incluidos hilos, VLA, complejos y biblioteca amplia— siguen fuera del perfil.
