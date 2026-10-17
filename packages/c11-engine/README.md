# @playground/c11-engine · P5 implementado en el perfil acordado · 0.1.0

Motor incremental de C para navegador y Node.js con perfil x86-64 Linux LP64. Interpreta C en una máquina virtual propia; no compila ni ejecuta instrucciones nativas. El core no depende de React, DOM, Worker, File ni filesystem. El paquete **no implementa C11 completo**: `CAPABILITIES` publica el perfil y una capacidad fuera de alcance produce un diagnóstico explícito.

## Cobertura de esta versión

P4 conserva las capacidades numéricas, de control, objetos y memoria de P1–P3. Añade traducciones C con macros de objeto, función y variádicas; `#` y `##`; `#undef`, condicionales, includes de archivos virtuales, trigraphs, continuaciones de línea, UCN y concatenación de literales. Los diagnósticos conservan archivo y línea tras `#line` e includes; se admiten `#error`, pragmas STDC y macros predefinidas enumeradas en `CAPABILITIES`.

P5 implementa el alcance acordado de nueve áreas de lenguaje: bit-fields/padding y miembros flexibles; qualifiers `const`, `volatile` y `restrict`; selección `_Generic`; `_Alignas`, `_Alignof`, `_Static_assert`, `stdalign.h`, `offsetof` y `max_align_t`; almacenamiento/linkage, block `extern`, semántica `inline` C11 y `_Thread_local` de un solo thread; composición de declaradores/typedef; promociones, conversiones y argumentos de funciones; duración, representación y tipo efectivo. El alcance está completado dentro del perfil publicado. `CAPABILITIES.phase` identifica la fase actual; `completeC11: false` expresa que el perfil no cubre C11 completo y no es un indicador de cierre de P5.

Aquí «parcial» describe la cobertura de familias completas de C11. El alcance de P5 es el perfil finito descrito y probado en las secciones siguientes; las APIs publicadas por `CAPABILITIES.stdioFunctions`, `stdlibFunctions` y `timeFunctions` están implementadas. Las capacidades fuera de esos conjuntos se identifican como límites del perfil, parte de P6 o `Unplanned`. Esta auditoría no encontró pendientes concretos adicionales en las APIs publicadas ni en los casos de declaradores y ámbitos de P5. Por tanto, P5 está implementado dentro del perfil acordado aunque C11 y las familias estándar sigan parciales.

### Alcance parcial de L07 y L11

La cobertura de declaraciones y conversiones se concreta en esta matriz finita de regresiones; no afirma cubrir todas las declaraciones o conversiones de C11.

| Área | Casos incluidos | Límite publicado |
| --- | --- | --- |
| L07 · declaradores y tipos | Composición probada de declaradores de puntero, array, función y puntero a función; alias `typedef`; arrays incompletos completados por un inicializador; ajuste de parámetros array/función a punteros; tipos compuestos para declaraciones de array y función, incluso entre unidades de traducción; rechazo de tipos incompatibles. | La completitud se comprueba según el contexto: las declaraciones permitidas pueden conservar tipos incompletos; se diagnostican los usos por valor que requieren completitud. La visibilidad cubre los espacios de nombres separados de etiquetas y nombres ordinarios, ocultamiento de typedef, ámbito de `for`, parámetros y etiquetas de prototipo. No declara completa toda la gramática ni todos los diagnósticos de L07. |
| L11 · promociones y conversiones | Promociones de `_Bool`, tipos enteros pequeños y enums a `int` en el perfil; `float` a `double` en llamadas variádicas o sin prototipo; conversión de argumentos a parámetros de prototipo; conversiones entre enteros con y sin signo según LP64; compatibilidad entre prototipos y declaraciones sin prototipo según las promociones por defecto. | `f()` conserva el significado de declaración sin lista de parámetros, mientras `f(void)` declara cero parámetros. El perfil elige `int` como tipo entero compatible de los enums; los enumeradores son constantes `int`, pero compartir ese tipo compatible no hace compatibles entre sí tipos enum distintos. Estas reglas no completan L11 ni implican detección universal de comportamiento indefinido. |

Los límites de arrays, funciones, punteros, aliases y compatibilidad se prueban en `tests/p5-language.test.mjs`, `tests/p5-language-extension.test.mjs` y `tests/p5-differential.test.mjs`; la visibilidad de typedef y los enums tienen regresiones específicas en `tests/p5-language.test.mjs` y `tests/p5-enum-types.test.mjs`. Los oráculos diferenciales usan GCC y Clang en `-std=c11 -pedantic-errors` para programas definidos del perfil.

La ampliación de biblioteca de P5 añade las APIs narrow declaradas en `<stdio.h>`, el subconjunto de `<stdlib.h>` publicado por `CAPABILITIES.stdlibFunctions` y diez funciones de `<time.h>`. Los archivos y temporales siguen dentro del filesystem virtual; `freopen` conserva la identidad de `FILE *`. En este perfil, `freopen(NULL, mode, stream)` cierra el stream anterior, devuelve `NULL` y establece `EINVAL`, sin elegir una nueva configuración; esta es la opción permitida por C11 cuando `filename` es nulo. `tmpfile` se elimina al cerrar o terminar, y `fpos_t` es `long` con offsets de bytes. La salida de streams es síncrona: `setbuf` no cambia el modo y `setvbuf` solo admite `_IONBF`; `_IOFBF` y `_IOLBF` devuelven error. Las conversiones wide `%lc`, `%ls` y `%l[` siguen rechazadas explícitamente.

El perfil de bit-fields se contrasta con GCC y Clang para ABI SysV x86-64; signedness de plain `int`, orden de bits, unidades compartidas y barreras de ancho cero son decisiones del perfil, no garantías universales de C11. Los miembros flexibles ocupan la cola de una asignación, no aumentan `sizeof`, y la asignación de structs copia solo su parte fija. Alineaciones explícitas aceptan potencias de dos hasta 65536 bytes; `malloc` proporciona alineación de 16 bytes. `max_align_t` tiene tamaño 32 y alineación 16 en este target. TLS distingue duración y conserva una sola instancia por sesión, sin modelo concurrente. Los casts entre puntero y `uintptr_t` conservan direcciones virtuales conocidas y vivas según el perfil. `volatile` conserva sus evaluaciones en la máquina abstracta. El detector dinámico de `restrict` cubre bases restrict independientes y solapamientos restrict/plain observados con modificación; permite derivados o copias de una misma cadena, solo lectura, falta de acceso y subobjetos disjuntos. No analiza solapamientos por operaciones byte a byte ni dentro de la biblioteca; la procedencia desconocida se maneja conservadoramente. No promete detectar todas las violaciones de alias ni todo comportamiento indefinido.

Un proyecto puede tener varias unidades de traducción. Cada unidad se prepara con su propio estado de macros y se enlaza antes de ejecutar. Se admiten linkage de archivo (`static`), `extern`, funciones `inline` y definiciones K&R dentro del perfil probado. Las definiciones externas y tentativas se validan entre unidades; el estado de objetos y macros no se comparte entre unidades como si fueran globales del preprocesador.

Las funciones variádicas admiten promociones por defecto y `va_start`, `va_arg`, `va_copy` y `va_end`. `main` admite `int main(void)`, `int main()` sin parámetros y `int main(int, char **)`; el vector `argv` es completo, termina en un puntero nulo y se configura por ejecución.

Los 17 headers listados en `CAPABILITIES.virtualHeaders` son fuentes C virtuales incorporadas, no copias del host. Su cobertura es parcial. Incluye subconjuntos probados de `assert.h`, `ctype.h`, `errno.h`, `inttypes.h`, `iso646.h`, `stdarg.h`, `stdalign.h`, `stdio.h`, `stdlib.h`, `string.h` y `time.h`, además de los headers numéricos, `stddef.h`. `<stdalign.h>` define `alignas`/`alignof` y los macros `__alignas_is_defined`/`__alignof_is_defined`; `<stddef.h>` ofrece `size_t`, `ptrdiff_t`, `offsetof` y `max_align_t` coherentes con el perfil.

La cobertura narrow de `<stdio.h>` incluye las 45 funciones de `CAPABILITIES.stdioFunctions`: familias `v*`, archivos virtuales/temporales, `freopen`, buffering perfilado y posiciones `fgetpos`/`fsetpos`, además de streams, EOF/error, lectura binaria y formatos. `printf` admite `%a`/`%A` para `double` y `long double`. Las conversiones wide `%lc`, `%ls` y `%l[` producen un diagnóstico explícito y quedan fuera de planificación. `CAPABILITIES.stdioFormatLimitations` conserva los máximos de `printf` (100 dígitos decimales o 100000 hexadecimales de precisión). `<stdlib.h>` ofrece conversiones numéricas narrow, asignación, búsqueda/ordenamiento, RNG determinista, entorno virtual vacío y terminación mediante el scheduler C; `system(NULL)` devuelve cero y `system` con comando falla con `ENOSYS`. `<time.h>` usa UTC y conserva el instante fijo `2024-01-01T00:00:00Z` cuando el core se ejecuta sin servicios de host; Run y Memory Viewer inyectan el reloj real del Worker. `time()` entrega segundos, `timespec_get()` deriva nanosegundos con resolución de milisegundos en esos Workers y `localtime` coincide con `gmtime`. Ninguna familia de headers está completa.

`long double` usa binary80 en el perfil x86-64 Linux y sus conversiones `%L` conservan el valor exacto, sin pasar por `double`. `<wchar.h>` y `wchar_t`, `wint_t`, `WEOF`, las funciones wide de `<stdlib.h>` (`mbtowc`, `wctomb`, `mbstowcs`, `wcstombs`) y las demás APIs de caracteres anchos constan como `Unplanned`. El alcance implementado de P5 incluye ampliaciones acotadas de APIs y formatos narrow de `<stdio.h>`, `<time.h>`, `<stdlib.h>` y declaradores/tipos del lenguaje. Las funciones actuales de `ctype.h`/`string.h` bajo locale C se conservan; los locales configurables (`Unplanned`), `<wctype.h>`, las funciones matemáticas `long double`, atomics, threads, VLA y otras capacidades no incluidas en el plan P5 quedan fuera de esa planificación.

## Perfil numérico

| Tipo | Tamaño | Representación |
| --- | ---: | --- |
| `_Bool`, `char`, `signed char`, `unsigned char` | 1 byte | `char` firmado de 8 bits |
| `short`, `unsigned short` | 2 bytes | Entero de 16 bits |
| `int`, `unsigned int` | 4 bytes | Entero de 32 bits |
| `long`, `unsigned long`, `long long`, `unsigned long long` | 8 bytes | Entero de 64 bits, almacenado con `BigInt` |
| Puntero a objeto o función | 8 bytes | Dirección virtual de 64 bits |
| `float`, `double` | 4 / 8 bytes | IEEE binary32 / binary64 |
| `long double` | 16 bytes | Valor x87 binary80 (64 bits de significando y 15 de exponente), con almacenamiento y alineación de 16 bytes |

El perfil usa little-endian, bytes de 8 bits, complemento a dos, `char` firmado y `FLT_EVAL_METHOD == 0`. Los enteros unsigned envuelven módulo 2^N. `long double` conserva binary80 en aritmética, memoria, argumentos variádicos y conversiones `%L`; esto no incluye las funciones `long double` de `math.h` ni promete conformidad Annex F. Se detectan algunos casos de comportamiento indefinido como overflow firmado, división entera por cero, shifts inválidos, lecturas sin inicializar y accesos fuera de los objetos virtuales. No se promete detectar todo comportamiento indefinido.

## Entradas públicas

| Import | Responsabilidad |
| --- | --- |
| `@playground/c11-engine/core` | `prepare`, `execute`, `createExecutionSession`, `createDebugSession` y tipos síncronos, sin acceso a entorno. |
| `@playground/c11-engine/browser` | `runFile(File)`, `runProject(project)` y lectura mediante `File.text()`. |
| `@playground/c11-engine/node` | `runFile(path)`, `runProject(project)` y lectura UTF-8 de rutas. |
| `@playground/c11-engine/syntax` | `scanC(source)` y listas de palabras clave/tipos compartidas con el editor. |

El core recibe un proyecto virtual:

```ts
interface SourceProject {
  entry: string;
  files: readonly { name: string; source: string }[];
  translationUnits?: readonly string[];
}
```

`files` contiene todas las fuentes y headers virtuales. `entry` identifica la unidad principal, que por defecto también es la única unidad de traducción. Cuando se proporciona `translationUnits`, el arreglo declara las unidades C en orden; los demás archivos solo pueden entrar como headers virtuales. Las inclusiones con comillas buscan junto al archivo actual y en la raíz virtual; las inclusiones con ángulos buscan en la raíz y entre headers incorporados. No se consulta el filesystem del host.

`PreparedProgram` es inmutable y reutilizable por la misma instancia del core. Su campo `hasHeapAllocationCalls` indica si alguna función del programa enlazado contiene una llamada directa resuelta a `malloc` o `realloc`, aunque esa función todavía no se haya llamado. Las declaraciones, `free`, nombres dentro de comentarios o cadenas y funciones del usuario con esos nombres no activan el indicador. Cada llamada a `execute` o `createExecutionSession` crea una sesión nueva: reinicia objetos, streams y archivos virtuales, `stdin`, argumentos, heap, contadores y salida. El preparado no es transferible a otro Worker mediante `structuredClone`.

`runFile` se conserva como adaptador de un archivo y `runProject` ejecuta un proyecto. Los dos devuelven una promesa desde los adaptadores; `prepare` y `execute` del core son síncronos. El adaptador no inicia Workers implícitamente.

## Entrada, salida y archivos virtuales

`ExecuteOptions.io` acepta estas entradas por ejecución:

```ts
{
  argv?: readonly string[];  // vector C completo; default [basename(entry)]
  stdin?: string | Uint8Array;
  files?: readonly { name: string; data: string | Uint8Array }[];
}
```

Las cadenas son UTF-8. Los archivos iniciales solo existen en el sistema virtual de stdio; `fopen` nunca abre rutas del host. Los bytes de `stdout` y `stderr` se devuelven como `Uint8Array` directamente en todos los resultados de ejecución, incluso tras un error o un límite; una preparación fallida no produce salida. La interfaz decodifica esos bytes como UTF-8 para mostrarlos.

`execute(program, options)` conserva el modo por lotes: el `stdin` configurado está completo y, al agotarlo —incluido el caso vacío—, las lecturas obtienen EOF inmediatamente. Para una sesión interactiva, `createExecutionSession(program, options)` deja stdin abierto después de los bytes iniciales. Ambas APIs aceptan un tercer argumento opcional `ExecutionRuntimeServices`, separado de `ExecuteOptions` para no poner callbacks en objetos transportables; `wallClock.nowEpochMilliseconds()` recibe una función que devuelve epoch milliseconds como `bigint`. Sin ese servicio, `time()` y `timespec_get()` usan el instante fijo de 2024. Con él, consultan el proveedor una vez por llamada, incluso dentro de una sesión, y normalizan epochs negativos antes de construir `timespec`. La aplicación puede pasar ese servicio desde su Worker; la API core no consulta el reloj del host. `time()` tiene resolución de segundos y puede repetir el mismo valor durante ese segundo; `timespec_get()` conserva resolución de milisegundos del proveedor del Worker. `clock()` mantiene el contador virtual de instrucciones. `resume()` corre el mismo VM hasta que termina, falla, alcanza un límite o devuelve `{ kind: 'input-needed', stdout, stderr, metrics }`. Esa salida son snapshots acumulados. El frame C y la lectura suspendida permanecen vivos, así que reanudar no vuelve a ejecutar el programa ni sus efectos.

Cuando devuelve `input-needed`, el consumidor añade bytes con `appendStdin(bytes)` y llama `resume()` otra vez. `endStdin()` cierra la entrada de forma sticky: primero se consumen todos los bytes ya añadidos y luego las lecturas obtienen EOF sin solicitar más entrada. Un buffer abierto temporalmente vacío no marca `feof`. Las lecturas interactivas publicadas en `CAPABILITIES.interactiveStdinFunctions` son `scanf`, `fscanf`, `getchar`, `getc`, `fgetc`, `fgets` y `fread`; las demás lecturas conservan su comportamiento actual. Los bytes añadidos cuentan una sola vez contra `maxIOBytes`; si el límite impide añadirlos, el siguiente `resume()` devuelve el resultado `limit` y conserva la salida previa. El core no decodifica UTF-8 ni expone callbacks de entorno.

`maxIOBytes` es un presupuesto separado de `maxMemoryBytes`. Cuenta `stdin`, archivos iniciales, bytes de salida y contenido residente en archivos virtuales, con una bolsa compartida. Sobrescribir o truncar un archivo libera del conteo los bytes que dejan de estar residentes. El valor predeterminado del core es 4 MiB; la UI usa 1 MiB. El filesystem virtual y sus streams se reinician en cada ejecución.

## Resultados, métricas y límites

`prepare` devuelve `prepared`, `prepare-error` o `limit`. `execute` devuelve `terminated`, `runtime-error` o `limit`. Los errores incluyen diagnósticos con `code`, mensaje, archivo, línea y columna; solo `terminated` tiene `exitCode`. Los bytes de salida parcial se conservan en los resultados de ejecución que terminan con error o límite.

`EngineMetrics` expone `prepareMs`, `executeMs`, `sourceChars`, `tokenCount`, `preprocessSteps`, `instructionCount` y `peakMemoryBytes`. En `ExecutionSession`, `executeMs` acumula preparación del runtime y el tiempo síncrono dentro de `resume()`; excluye el tiempo esperando que el consumidor añada stdin. `maxPreprocessSteps` mide expansión y traducción del preprocesador por separado de `maxTokens` y excluye el EOF final. Valores predeterminados del core:

- Preparación: 1.000.000 caracteres, 200.000 tokens, 5.000.000 pasos de preprocesamiento y profundidad 128.
- Ejecución: 1.000.000 instrucciones, 16 MiB de objetos C, 4 MiB de E/S virtual y profundidad 128.

Cada límite admite un entero seguro no negativo o `null` para desactivarlo. `maxMemoryBytes` cuenta parámetros, locales, objetos globales/estáticos, literales de cadena y heap virtual, no el consumo del proceso JavaScript. `maxIOBytes` cuenta bytes de entrada/salida virtual, no memoria C.

Los adaptadores publican `readMs`, `prepareMs`, `executeMs` y `totalMs`. El tiempo de arranque/comunicación del Worker queda fuera. `AbortSignal` se revisa antes/después de leer y entre etapas; el core síncrono no puede procesar eventos nuevos durante una ejecución. Para cancelación activa y watchdog, la aplicación termina el Worker desde el hilo padre.

## Ejemplo de uso del core

```ts
import { prepare, execute } from '@playground/c11-engine/core';

const prepared = prepare({
  entry: 'main.c',
  translationUnits: ['main.c', 'helper.c'],
  files: [
    { name: 'main.c', source: '#include "helper.h"\nint main(int n, char **v) { return helper(n, v); }' },
    { name: 'helper.c', source: '#include "helper.h"\nint helper(int n, char **v) { return n + (v[0][0] != 0); }' },
    { name: 'helper.h', source: 'int helper(int, char **);' },
  ],
});
if (prepared.kind !== 'prepared') throw new Error(prepared.diagnostics[0].message);

const result = execute(prepared.program, {
  io: { argv: ['demo', 'extra'], stdin: 'input', files: [] },
});
if (result.kind === 'terminated') {
  console.log(result.exitCode, new TextDecoder().decode(result.stdout));
}
```

Una aplicación con Worker puede coordinar una sesión interactiva sin pasar objetos del navegador al core:

```ts
import { createExecutionSession, prepare } from '@playground/c11-engine/core';

const prepared = prepare({ entry: 'main.c', files: [{ name: 'main.c', source }] });
if (prepared.kind !== 'prepared') throw new Error('No se pudo preparar el programa.');
const session = createExecutionSession(prepared.program);
declare function readLine(): Promise<string | null>; // null significa EOF en la aplicación
let progress = session.resume();
while (progress.kind === 'input-needed') {
  // La aplicación recibe/decodifica el snapshot de stdout y obtiene la línea fuera del core.
  const line = await readLine();
  if (line === null) session.endStdin();
  else session.appendStdin(new TextEncoder().encode(`${line}\n`));
  progress = session.resume();
}
```

El consumidor reanuda cada vez que haya entrada o envía EOF; una espera humana debe vivir fuera del core síncrono. En la aplicación, el watchdog de ejecución se pausa durante esa espera y `Stop` termina el Worker, lo que descarta la sesión sin pedirle callbacks ni cancelación al motor.

## Depuración: ciclo de vida y avance por línea

`createDebugSession(program, executeOptions?, debugOptions?, runtimeServices?)` usa la misma VM y memoria que una sesión normal; el cuarto argumento permite al host inyectar el mismo servicio de reloj sin cambiar las opciones de depuración. Solo la sesión debug recolecta eventos de ciclo de vida y habilita inspectores bajo demanda de escalares, arrays, objetos estáticos observados y allocations heap vivas. Su entrada siempre es `main`: la creación inicializa los objetos globales y sus inicializadores, y entra en el scope raíz de `main` antes de ejecutar la primera instrucción del cuerpo. Conserva el evento `scope-enter` y la pausa inicial de `main`, sin publicar sus variables automáticas futuras. La VM reserva internamente las celdas locales al entrar al scope; `object-create` y la inspección escalar aparecen al ejecutar cada declaración. Los parámetros se publican al entrar en su función, antes de su primera instrucción. Esta temporización es exclusiva de la observabilidad debug y no cambia la semántica normal de C. `currentLocation()` señala la siguiente posición de fuente que se ejecutará; devuelve `null` si falla ese setup o la sesión ya tiene un resultado terminal.

`CAPABILITIES.preparedProgram.heapAllocationHint` publica que el preparado incluye `hasHeapAllocationCalls`, una pista calculada desde las llamadas resueltas del IR enlazado. `CAPABILITIES.stdlibFunctions` publica la familia disponible de `<stdlib.h>`; `malloc`, `calloc`, `realloc`, `free` y `aligned_alloc` usan la memoria virtual del motor. `aligned_alloc` admite alineaciones potencia de dos de hasta 65536 bytes y tamaños múltiplos de la alineación; si no se cumple, devuelve `NULL` y establece `EINVAL`.

`resume()` ejecuta la visita actual de línea y devuelve `paused` antes de la primera instrucción cuya ubicación tenga otro archivo o línea. Las instrucciones contiguas de una misma línea se agrupan; las llamadas avanzan dentro de la función llamada. Si, durante un mismo `resume()`, el VM vuelve al mismo PC en el mismo frame, la visita se pausa antes de repetirlo. Esto permite avanzar por bucles y `goto` que vuelven a una línea sin quedarse ejecutándola indefinidamente. Todos los avances incluyen snapshots acumulados de `stdout` y `stderr`: `paused`, `input-needed`, los resultados terminales y los límites conservan la salida emitida hasta ese punto. Cada snapshot preserva el orden de bytes de su propio stream; los dos snapshots no describen el intercalado global entre `stdout` y `stderr`.

Debug usa las mismas opciones `ExecuteOptions.io` que Run: `argv`, `stdin` inicial y `files` virtuales. `printf`/`fprintf` y las demás funciones stdio escriben o leen por el `VirtualIO` compartido; las rutas de `fopen` nunca acceden al host. Como en `createExecutionSession`, stdin queda abierto incluso después de consumir los bytes iniciales, de modo que el agotamiento temporal no equivale a EOF. Si una lectura necesita más bytes, `resume()` devuelve `{ kind: 'input-needed', location, stdout, stderr, metrics }`; `location` identifica la instrucción suspendida y los buffers de salida son snapshots acumulados, por lo que el prompt se puede mostrar mientras se espera. Llamar `resume()` antes de añadir entrada devuelve la misma espera sin ejecutar efectos. Tras `appendStdin(bytes)` o `endStdin()`, `resume()` continúa la misma lectura y visita de línea: conserva argumentos ya evaluados, conversiones parciales y efectos previos, y no vuelve a ejecutar la instrucción. `endStdin()` consume primero los bytes almacenados y luego produce EOF sticky. Las lecturas interactivas están publicadas en `CAPABILITIES.interactiveStdinFunctions`; `maxIOBytes` limita la entrada y salida igual que en Run. `execute()` conserva el modo por lotes, donde stdin está completo y su agotamiento —incluido el caso vacío— es EOF.

La API de sesión es:

```ts
interface DebugExecutionSession {
  resume(): DebugProgress;
  appendStdin(bytes: Uint8Array): void;
  endStdin(): void;
  currentLocation(): DebugSourceLocation | null;
  drainEvents(): readonly DebugEvent[];
  inspectScalars(): readonly DebugScalarSnapshot[];
  inspectPointers(): readonly DebugPointerSnapshot[];
  inspectStaticObjects(options?: DebugStaticObjectInspectionOptions): readonly DebugStaticObjectSnapshot[];
  inspectArrays(): DebugArrayInspection;
  inspectAggregates(): DebugAggregateInspection;
  inspectHeapObjects(): readonly DebugHeapObjectSnapshot[];
}

interface DebugScalarSnapshot {
  readonly id: number;       // allocationId real del object-create
  readonly scopeId: number;
  readonly frameId: number;
  readonly name: string;
  readonly origin: DebugObjectOrigin; // distingue parámetros y variables locales
  readonly type: string;
  readonly address: string;  // hexadecimal exacto
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string; // valor completo o "?"
}

interface DebugPointerSnapshot {
  readonly id: number; // allocationId de la variable puntero
  readonly scopeId: number | null;
  readonly frameId: number | null;
  readonly name: string;
  readonly origin: 'variable' | 'parameter';
  readonly duration: 'automatic' | 'static' | 'thread-local';
  readonly region: 'stack' | 'static';
  readonly type: string;
  readonly address: string; // dirección propia del objeto puntero
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string; // dirección almacenada en hexadecimal, o "?"
  readonly status: 'uninitialized' | 'null' | 'live' | 'one-past' | 'dangling' | 'unmapped' | 'function';
  readonly target?: {
    readonly allocationId: number;
    readonly byteOffset: number;
    readonly type: string;
    readonly name?: string;
  };
}

interface DebugStaticObjectSnapshot {
  readonly id: number; // allocationId real del object-create
  readonly name?: string; // sin nombre para literales de cadena
  readonly origin: 'variable' | 'string-literal';
  readonly duration: 'static' | 'thread-local';
  readonly type: string;
  readonly address: string;
  readonly size: number;
  readonly initialized: boolean;
  readonly displayValue: string;
}

interface DebugStaticObjectInspectionOptions {
  readonly includeStringLiterals?: boolean; // true por defecto, por compatibilidad
}

interface DebugArrayInspection {
  readonly arrays: readonly DebugArraySnapshot[];
  /** Roots excluded by maxObjects only; unsupported arrays remain in arrays as descriptors. */
  readonly omittedObjects: number;
}

interface DebugArraySnapshot {
  readonly rootId: number; // allocationId real del object-create
  readonly name?: string; // sin nombre para literales de cadena
  readonly origin: 'variable' | 'string-literal';
  readonly duration: 'automatic' | 'static' | 'thread-local';
  readonly region: 'stack' | 'static';
  readonly frameId: number | null;
  readonly scopeId: number | null;
  readonly type: string;
  readonly elementType: string;
  readonly address: string;
  readonly size: number;
  readonly length: number;
  readonly readOnly: boolean;
  readonly status: 'available' | 'too-many-elements' | 'multidimensional' | 'unsupported-element-type';
  readonly elements: readonly DebugArrayElementSnapshot[];
}

interface DebugArrayElementSnapshot {
  readonly key: string; // `${rootId}:${index}`
  readonly index: number;
  readonly address: string;
  readonly type: string;
  readonly initialized: boolean;
  readonly displayValue: string; // formato escalar C completo o "?" si indeterminado
  readonly valueTruncated: boolean;
}

interface DebugHeapObjectSnapshot {
  readonly id: number;      // allocationId real del object-create
  readonly address: string; // hexadecimal exacto
  readonly size: number;    // bytes solicitados a malloc
  readonly origin: 'heap';
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

Ejemplo mínimo (donde `prepared` es un `PreparedProgram` ya preparado):

```ts
import { createDebugSession, DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS } from '@playground/c11-engine/core';

const session = createDebugSession(
  prepared.program,
  { io: { argv: ['demo'] } },
  { maxEvents: 20_000, ...DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS },
);
let events = session.drainEvents(); // incluye los eventos emitidos durante setup
let progress = session.resume();
while (progress.kind === 'paused') {
  const next = session.currentLocation();
  events = session.drainEvents(); // solo los eventos desde el drain anterior
  const scalars = session.inspectScalars(); // valores actuales; no evalúa ni modifica C
  const pointers = session.inspectPointers(); // direcciones y estado; nunca lee el destino
  const staticObjects = session.inspectStaticObjects({ includeStringLiterals: false }); // valores static actuales; los literales se inspeccionan en arrays
  const arrays = session.inspectArrays(); // arrays primitivos acotados y caracteres de literales
  const aggregates = session.inspectAggregates(); // miembros directos de struct con layout acotado
  progress = session.resume();
}
events = session.drainEvents(); // eventos restantes del último avance
```

`drainEvents()` devuelve en orden los eventos acumulados desde la llamada anterior y vacía la cola pendiente; incluye los objetos globales y los eventos de entrada a `main`, scope raíz y objetos locales emitidos durante la construcción de la sesión. Se puede llamar antes del primer `resume()` para inspeccionar el setup. Drenar no reinicia el contador ni el límite total.

`DebugEvent` es un DTO readonly y serializable. `sequence` empieza en 1, es creciente y solo se asigna a eventos confirmados. Los eventos son `frame-enter`, `frame-exit`, `scope-enter`, `scope-exit`, `object-create` y `object-delete`. Todos llevan `location` (`file`, `line`, `column`) y `frameId`/`scopeId` nullable; los IDs de frames y scopes identifican activaciones dinámicas, así que las llamadas recursivas y cada entrada repetida al mismo bloque son distintas. Los eventos de frame llevan `functionName`; los de scope llevan además `scopeName`, asignado desde el AST. El cuerpo de función usa su nombre y un bloque desnudo usa `bloque`. Las etiquetas de control son canónicas y no incluyen sus condiciones: `if(...)`, `while(...)`, `for(...)`, `do { ... } while (...)` y `switch(...)`; `else` conserva `else`. El bloque de un `for` usa `bloque de for`. Un bloque compuesto de control produce una sola activación de scope; los bloques anidados siguen siendo activaciones independientes. Un evento de frame usa su `frameId` y `scopeId: null`; uno de scope identifica ambos.

`inspectScalars()` devuelve un array y DTOs nuevos, readonly y serializables con las variables aritméticas automáticas cuya declaración ya se ejecutó y los parámetros de frames activos: `_Bool`, tipos `char`, enteros con signo y sin signo, `float`, `double`, `long double` y enums con el nombre de tipo enum y representación entera del perfil. `origin` distingue `parameter` de `variable` usando la metadata del binding y coincide con el `origin` del `object-create` correlacionado; no se deduce por nombre, tipo ni ubicación de fuente. `CAPABILITIES.debugSession.objectOrigins` publica los valores posibles para eventos de objeto y snapshots escalares. Los IDs `id`, `scopeId` y `frameId` son los mismos números usados por los eventos de objeto/scope/frame; `id` coincide con `allocationId` del evento `object-create`. `address` es hexadecimal desde la dirección virtual BigInt, sin pasar por `Number`. El campo `type` conserva la etiqueta del enum, por ejemplo `enum Estado`; el valor usa la representación compatible `int`. `initialized` es falso cuando aún no hay un valor determinado y `displayValue` contiene `?`; consultar un objeto así no produce `UNINITIALIZED_READ`, no lo inicializa ni cambia eventos o ubicación.

`inspectPointers()` publica variables puntero automáticas y parámetros activos, junto con variables puntero static o `_Thread_local` que el runtime ya observó. `id` es el allocationId real del objeto puntero; `address` identifica su propio almacenamiento y `displayValue` muestra, por separado, la dirección almacenada, formateada con BigInt. Un puntero sin inicializar conserva `initialized: false`, `status: 'uninitialized'` y `displayValue: '?'`; un puntero nulo conserva `initialized: true`, `status: 'null'` y `displayValue: '0x0'`. Los demás estados son `live`, `one-past`, `dangling`, `unmapped` y `function`. Los objetos `_Thread_local` conservan `duration: 'thread-local'` aunque su región pertenezca al almacenamiento static de esta sesión. Cuando la representación conserva provenance, `target` contiene el allocationId del destino, su byteOffset exacto y el tipo designado. El nombre opcional solo identifica un objeto raíz cuando la identidad, el tipo y el offset cero coinciden. El snapshot no busca por dirección, no inspecciona el destino y no depende del límite de `inspectArrays()`; consultar punteros tampoco recorre ni formatea arrays.

Un consumidor puede asociar `target` con una celda de `inspectArrays()` cuando `target.allocationId` coincide con `rootId` y el byteOffset y tipo coinciden exactamente con una celda publicada. Esto incluye el `\\0` real de arrays de caracteres y literales observados. Solo hay celdas para arrays primitivos unidimensionales con `status: 'available'`; one-past, offsets interiores o mal alineados, matrices, arrays placeholder sobre el límite y targets dangling no producen una asociación. Un allocationId retirado nunca se vuelve a asociar a otro objeto aunque el allocator reutilice su dirección virtual. La inspección no lee valores mediante C ni emite eventos o diagnósticos, así que escribir mediante `*p` conserva la semántica del programa y el snapshot de una pausa previa sigue inmutable.

`inspectStaticObjects()` devuelve los valores actuales de objetos aritméticos globales, static locales y `_Thread_local` que el runtime ya creó, además del contenido de los literales de cadena que ya asignó a memoria. Cada snapshot conserva `duration: 'static'` o `duration: 'thread-local'`; ambos viven en la región static de la sesión única, pero TLS no simula hilos concurrentes. Los snapshots usan el allocationId, el origin, la dirección y el tamaño de los eventos reales; no tienen frameId ni scopeId porque su duración no pertenece a una activación C. Los escalares reutilizan el formatter numérico y de caracteres; cada literal usa type char[N], initialized true y un displayValue C-escapado entre comillas que incluye el terminador NUL. Los literales no tienen nombre. La opción `includeStringLiterals: false` omite los literales antes de leer o formatear su preview; el valor predeterminado sigue siendo `true` para conservar el contrato existente. Un consumidor que usa `inspectArrays()` para mostrar literales debe pedir los escalares static con esa opción, así el preview antiguo sin límite no recorre la cadena además de las celdas acotadas.

`inspectArrays()` devuelve roots vivos de arrays declarados automáticos, static o TLS y los literales de cadena observados. Los objetos TLS se muestran en `region: static` dentro de la sesión única del motor. El root usa el allocationId real, conserva nombre/origin/duración/dirección/tamaño y publica frame/scope para arrays automáticos; `region` es `stack` o `static`. Cada celda disponible tiene índice, dirección virtual, tipo, identidad estable `${rootId}:${index}`, estado `initialized` y el mismo formato numérico o de caracteres C que los escalares. Un elemento no inicializado mantiene `initialized: false` y `displayValue: '?'`; el visor puede presentarlo con su marcador visual. Los caracteres se muestran solo como celdas con índices, escapando controles y haciendo visible `\\0`; no se incluye preview de texto. Con las opciones predeterminadas, un literal observado también sigue apareciendo en `inspectStaticObjects()` con el mismo ID para mantener esa API existente. El Memory Viewer agrupa objetos estáticos y thread-local en la región `Static / TLS`, conserva `data-duration` y los distingue en su etiqueta accesible.

Solo los arrays unidimensionales con elementos aritméticos tienen celdas. Matrices devuelven `status: 'multidimensional'`; arrays de punteros, struct u otros elementos no soportados devuelven `status: 'unsupported-element-type'`; arrays que superan el límite solicitado devuelven `status: 'too-many-elements'`. En esos casos el descriptor conserva longitud y metadatos, pero `elements` queda vacío; no se recorren sus elementos. El motor no limita ni rechaza la ejecución C. Un `char raw[3] = "abc"` produce tres celdas y sigue siendo un array C válido sin terminador; no se inventa NUL ni se emite diagnóstico por ello. Por el contrario, `char text[5] = "hola"` tiene cinco celdas y la última muestra `\\0`.

`inspectAggregates()` publica roots vivos `struct` observados en duración automática, estática o TLS, además de agregados heap con una vista efectiva tipada. El snapshot conserva allocationId, dirección, tamaño, región y scope/frame cuando existen. Un struct de hasta diez miembros directos publica nombres, tipos calificados, offsets, tamaños y direcciones; los miembros aritméticos usan el formatter de escalares y los punteros publican estado, dirección y provenance por allocationId/byteOffset. Los bit-fields nombrados conservan `bitWidth`, `bitOffset` desde el bit menos significativo y `storageUnitSize`; `offset` apunta al inicio de su unidad compartida. El separador sin nombre de ancho cero se omite. El placeholder de un miembro flexible publica `elementSize`, `capacityBytes` y `length` para el extent real de su asignación; si sus elementos son aritméticos, también incluye celdas con el DTO/formato de arrays hasta `maxElementsPerArray`, `status` y `omittedElements`. El presupuesto `maxValueChars` se aplica igual que en arrays; elementos de tipo no soportado conservan el placeholder sin inventar valores. Los snapshots no evalúan expresiones C, no siguen punteros, no materializan subobjetos ni modifican la inicialización; las copias guardadas son DTOs serializables e independientes de cambios posteriores. Arrays, structs y unions miembros siguen como placeholders; no se aplanan miembros anónimos. Los roots union y structs con más de diez miembros conservan metadatos y tamaño, pero no publican miembros. `padding` contiene rangos exactos según el layout del perfil. El límite de diez es solo de visualización y no restringe el lenguaje C admitido.

El espacio virtual LP64 tiene tres regiones disjuntas publicadas por `VIRTUAL_MEMORY_LAYOUT` y `CAPABILITIES.virtualMemory`: Static `[0x10000, 0x20000)`, Stack `[0x20000, 0x30000)` y Heap `[0x30000, 0x40000)`. Cada una tiene 64 KiB nominales. Los inicios se alinean a 16 bytes y cada allocation reserva espacio para sus bytes C, 16 bytes de guard y el redondeo a la alineación; por eso el total de bytes C que cabe depende del tamaño y cantidad de objetos. `maxMemoryBytes` cuenta solo bytes C vivos, sin guards, y no amplía una región virtual. Static persiste durante la sesión; Stack busca el primer extent disponible y lo libera al terminar el scope/frame para poder reutilizarlo. Agotar Static o Stack produce respectivamente `STATIC_ADDRESS_SPACE_EXHAUSTED` o `STACK_ADDRESS_SPACE_EXHAUSTED` con ubicación de fuente. Agotar Heap conserva la semántica del perfil: `malloc` devuelve `NULL`, sin diagnóstico de región.

`inspectHeapObjects()` devuelve únicamente los bloques vivos obtenidos con `malloc` o `realloc`. Cada snapshot usa el `id`/`allocationId` y dirección de su allocation actual, conserva el tamaño solicitado en bytes y mantiene la procedencia opaca `heap`; no inventa tipo, nombre ni valor C. Una reasignación exitosa copia los primeros `min(tamaño anterior, tamaño nuevo)` bytes y crea una identidad de objeto nueva, incluso si conserva la dirección. `free` y `realloc(p, 0)` eliminan inmediatamente el bloque de la vista y liberan su intervalo; una reserva fallida de tamaño no cero devuelve `NULL` y conserva íntegro el bloque anterior. Las direcciones de otros bloques vivos no cambian. El allocator prueba ubicaciones pseudoaleatorias dentro de `[0x30000, 0x40000)` con búsqueda acotada y busca huecos libres si la zona está fragmentada; sus extents consumen metadata por bloque vivo, no por byte reservado. `CAPABILITIES.virtualMemory.heapAddressRange` publica base, fin exclusivo, capacidad nominal, alineación, guard y que la aleatoriedad no es criptográfica. `debugOptions.heapAddressSeed`, un entero de 32 bits, vuelve reproducible la secuencia solo para sesiones debug; sin seed, el allocator usa el RNG disponible en el runtime. `malloc(0)`, `realloc(NULL, 0)` y `realloc(p, 0)` no dejan bloques vivos. Una llamada nueva devuelve DTOs actuales; los snapshots guardados por el consumidor sirven para mostrar pausas anteriores.

Los valores enteros y enums se expresan en decimal exacto; `_Bool` como `0` o `1`; `char` como literal entre comillas con escapes C (por ejemplo, `'C'` o `'\n'`); `float` y `double` usan el decimal más corto que vuelve al mismo valor, y `long double` muestra su valor binary80 en hexadecimal exacto. Se conservan `-0`, `nan`, `inf` y `-inf`. Los valores de los inspectores escalares y de `inspectStaticObjects()` son completos; la interfaz decide si acorta su presentación. Los elementos de `inspectArrays()` pueden recortarse según `maxValueChars`, y `valueTruncated` indica cuándo ocurrió.

La inspección está disponible antes del primer `resume()`, en pausas y después de un resultado terminal. Tras una terminación normal los scopes ya cerraron y devuelve `[]`; tras un error o límite conserva solo los objetos que seguían vivos cuando el VM se detuvo. No fuerza unwind ni añade estado de historial. Cada llamada toma los valores actuales, así que un consumidor que necesite historial debe guardar los DTO de cada pausa.

Los eventos de objeto describen una raíz de memoria: `objectId` y `allocationId` tienen el mismo ID del allocation, `duration` distingue `automatic`, `static`, `thread-local`, `heap` y `compound-literal`, y `origin` distingue `variable`, `parameter`, `compound-literal`, `heap` y `string-literal`. Pueden incluir `name`; también llevan un `typeSummary` textual, `addressVirtual` como `bigint` y `size` en bytes. Las variables automáticas y los compound literals automáticos llevan los IDs de frame y scope que poseen su duración. Heap, objetos estáticos, thread-local y literales de string llevan `null` en ambos campos, también al eliminar heap con `free`. Las variables globales y locales `static`, TLS, arrays y structs se informan como un único objeto raíz; sus miembros, elementos y subobjetos no generan nodos. Observar eventos no lee valores C, no materializa miembros ni cambia el estado de objetos no inicializados.

Se informa la publicación de objetos automáticos al ejecutar su declaración y la de parámetros al entrar en su función. La VM reserva internamente las celdas locales al entrar al scope; esa reserva no crea un evento anticipado. La eliminación se emite solo para un `allocationId` que ya tuvo `object-create`. También se informan objetos estáticos al inicializarse por primera vez, literales de string C observables y bloques heap exitosos de `malloc`/`realloc`; `free` y una reasignación exitosa producen los eventos de eliminación correspondientes si el bloque anterior estaba trazado. Los objetos globales pueden emitir eventos durante la construcción de la sesión; los objetos locales `static` se crean cuando el VM alcanza por primera vez su scope de declaración. Por eso, un local `static` en una función o bloque que no se alcanza no produce evento. La API reporta allocations que la VM realizó y no preasigna objetos solo para depuración. `free(NULL)`, `realloc(NULL, 0)`, `realloc(p, 0)`, frees inválidos y asignaciones fallidas no producen eventos de creación; invalidar un bloque heap trazado sí publica su eliminación. Los objetos estáticos y literales de string persisten sin una eliminación sintética al terminar el programa. No se exponen objetos de soporte creados por la implementación para `errno`, stdio, `argv` o variádicas.

`DebugSessionOptions.maxEvents` limita el total de eventos confirmados por la sesión (por defecto, 100.000), aunque se drene la cola. `heapAddressSeed` controla la aleatoriedad heap reproducible para pruebas y depuración. `maxObjects` (por defecto, 1.000) limita roots que devuelve cada inspector acotado (`inspectArrays` e `inspectAggregates`); `omittedObjects` cuenta los excluidos por ese presupuesto. `maxElementsPerArray` (por defecto, 10) limita las celdas que se inspeccionan por root e incluye NUL y ceros de relleno; `maxValueChars` (por defecto, 256) limita cada `displayValue` de elemento de array y `valueTruncated` indica si fue recortado. Los miembros de struct usan el límite fijo `DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS.maxMembers` (10) y valores completos. El motor exporta los objetos `DEFAULT_DEBUG_ARRAY_INSPECTION_LIMITS` y `DEFAULT_DEBUG_AGGREGATE_INSPECTION_LIMITS`; un host puede derivar de ellos los presupuestos comunes y pasar sus ajustes en `debugOptions`. Antes de una operación instrumentada se reserva el presupuesto de eventos; si no queda espacio, `resume()` devuelve `kind: 'debug-limit'`, `resource: 'maxDebugEvents'`, el límite, diagnóstico y métricas. El consumidor puede drenar el prefijo completo que sí se emitió; la sesión se detiene sin truncarlo silenciosamente y sin inventar salidas de scope/frame. Un límite de ejecución o error tampoco fuerza unwinds. El presupuesto debug es independiente de `maxMemoryBytes`; los eventos consumen memoria de historial solo en sesiones debug, mientras que los inspectores se generan bajo demanda y no cuentan como eventos. No hay snapshots de escrituras ni historial/reversa. El cierre normal de un bloque informa la ubicación del token `}` conservado por el parser; los scopes cerrados por `return` o salto usan la ubicación de esa transición. `frame-enter` usa la declaración de la función y `frame-exit` usa el `return` explícito o, al caer al final, la llave de cierre del cuerpo.

## Desarrollo y validación

Desde el repositorio:

```sh
pnpm --filter @playground/c11-engine build
pnpm --filter @playground/c11-engine test
pnpm test
```

Las regresiones de P1–P4 se conservan junto a las suites P5, que incluyen diagnósticos, multiunidad, layout y diferenciales nativos GCC/Clang bajo el perfil LP64. Las pruebas diferenciales usan programas fijos y nunca toman el texto del editor para ejecutar código en el host. La matriz C11 documenta las familias parciales y las capacidades que siguen pendientes; pasar una aceptación mínima no completa por sí sola una familia.
