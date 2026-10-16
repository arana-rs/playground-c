# AGENTS.md

## Forma de trabajar

- Reutiliza componentes, hooks y funciones existentes antes de crear otros.
- Mantén una sola fuente de verdad para lógica, constantes y configuración.
- Conserva los cambios existentes del usuario.
- Comunica avances y resultados en español.

## Subagentes

- El agente principal actúa principalmente como orquestador y delega todas las tareas operativas a subagentes: investigación e inspección del código, implementación, documentación, pruebas y compilaciones, navegación y depuración en navegador, revisión de código y operaciones Git solicitadas.
- Para cada subagente, selecciona explícitamente el modelo `gpt-6-luna` y el esfuerzo de razonamiento `max`; no heredes el modelo ni el esfuerzo del agente principal.
- El agente principal aclara objetivos, divide el trabajo, asigna y coordina tareas, sigue el progreso y consolida los resultados para el usuario.
- Da a cada subagente contexto breve y específico para su tarea; evita pasarle todo el historial si no es necesario.

## Arquitectura

- El motor C vive en packages/c11-engine y es independiente de React.
- El core no debe importar DOM, File, Worker ni filesystem.
- Comparte el escáner de C entre motor, coloreo y contexto del editor.
- Conserva BigInt para enteros LP64 y las conversiones del perfil.
- Ejecuta el código del editor dentro del Worker.
- Reutiliza RUN_CONFIGURATION para los presupuestos de ejecución.

## Editor y diseño

- Sigue docs/px0-style-reference.md para cambios visuales.
- Conserva el estilo compacto px0; admite temas GitHub Dark y GitHub Light, con la sintaxis correspondiente y la preferencia persistida.
- Reutiliza el Button de Arc para Run/Stop.
- Stop debe permanecer habilitado durante la ejecución.
- Conserva selección, historial, sangría, pares y composición IME.
- El ejemplo inicial vive en src/examples/main.c; evita duplicarlo.
- Los rerenders y Run deben conservar las ediciones del usuario.
- En Memory Viewer, Stack crece hacia la derecha y los scopes aparecen al entrar. Oculta solo el marcador del scope raíz de main; conserva sus variables, scopes anidados y los de las demás funciones. Usa amarillo para el scope actual y un tono más pálido para los anteriores.

## Motor y fases

- Consulta docs/c11-engine-roadmap.md al ampliar capacidades.
- Consulta packages/c11-engine/README.md para la API y semántica.
- Una función pendiente debe producir un diagnóstico explícito.
- Al añadir capacidades, actualiza pruebas, CAPABILITIES y documentación.

## Comandos y validación

- Desarrollo: pnpm dev --host 0.0.0.0 --port 5173 --strictPort
- Pruebas: pnpm test
- Compilación y TypeScript: pnpm build
- Elige las comprobaciones según el cambio.
- Para cambios del editor, comprueba edición, deshacer y rehacer.
- Para cambios de ejecución, comprueba Run, Stop y diagnósticos.
- Completa las compilaciones antes de probar en navegador:
  reconstruir el motor puede provocar recargas de Vite.
- Al crear un commit solicitado, incluye solo los cambios de esa tarea.
