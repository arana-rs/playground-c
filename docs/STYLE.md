# Project Compact UI Style Guide

This guide defines the visual direction for the playground and Memory Viewer. It describes the project interface; implementations and their current values live in the components and `../src/style.css`. Before changing a style, reuse the existing tokens and patterns. Do not keep a second copy of the palette or CSS measurements here.

The interface stays compact to leave room for code, the console, and memory regions. Use restrained surfaces, fine dividers, and small corner radii. Reserve the accent for focus, selection, execution, and actions. Establish hierarchy through order, type weight, and contrast, without repeated decorative borders or shadows.

## Tokens and themes

`../src/style.css` is the single source of truth for shared visual tokens and their theme values. Use existing variables according to their role: surfaces (`--bg`, `--bg2`, `--bg3`, `--bg4`, `--chrome`), text (`--fg`, `--dim`, `--faint`), dividers (`--line`), interaction (`--accent`, `--accent-fg`, `--selection`), syntax (`--syntax-*`), status (`--status-*`), and memory (`--memory-*`). If a new visual need fits one of these roles, reuse that token instead of creating an alias or a parallel local palette. Keep component-specific variables scoped to their component.

The application supports `github-dark` and `github-light`, selectable from the theme control and saved in `localStorage` under the key `c-playground-color-theme`. They are applied through `data-theme`; if there is no valid preference or storage is unavailable, GitHub Dark is used. Preserve the syntax colors for each theme through the same `--syntax-*` roles; do not hard-code syntax colors in components.

## Density, typography, and structure

The interface uses the system `--ui` stack and reserves `--mono` for code, output, addresses, and values. The current base size is 13 px. The editor uses 13.5 px with a 21 px line height and four-space tabs; the console uses 12.5/18 px. These specific values live in CSS, which is the reference when adjusting them.

Keep the header, file tab, controls, and section headers compact. The editor and results use the available workspace; fine dividers organize the header, tabs, console, and memory regions. Sizing and layout may respond to the viewport, keyboard, and console resizing while preserving useful content and accessible controls.

Panels use short, understated titles; their headers distinguish the chrome from the content without competing with the code. Use the accent or selection color to identify the active tab, current state, and execution line. States must also have text or another cue in addition to color. Keep keyboard focus visible on controls.

## Controls and execution

Reuse Arc's `Button` for actions and its existing integration with the compact palette. Run and Stop retain the size and weight of the chrome. During execution, Run changes to Stop, and Stop remains enabled for cancellation. The same cancellation control stays available while debugging is active.

Keep the theme selector compact and accessible. The Memory Viewer mode, I/O, history, and close controls retain their labels, focus states, and contextual availability.

## Editor

The editor prioritizes C text, with line numbers and diagnostics aligned in a quiet gutter. The execution line may be highlighted without obscuring text or taking focus away from editing. Syntax highlighting uses the project's shared scanner and the color roles of the active theme.

Presentation changes, state updates, and Run must preserve the user's edits. Preserve selection and cursor position, undo and redo, indentation, delimiter pairs, IME composition, and scrolling. The initial example is `../src/examples/main.c`; do not duplicate it in this guide or in components.

## Console

The console sits below the editor, separated by a fine line and a resizable divider. Its header shows the state in text and with a visual cue. Output uses monospace type, preserves stdout and stderr, and labels stderr in the text. System messages, warnings, and errors use the existing color roles. Preserve interactive input, EOF, and Stop where applicable; do not remove partial output or diagnostics when showing a result.

## Memory Viewer

Regions appear in the order Static → Stack → Heap. Static and Heap keep their lists, and Stack grows horizontally to the right. Scopes appear when entered and progress from left to right, oldest to newest. The current scope uses the yellow from `--mark-active`; active ancestor scopes use a paler shade. Scopes that exit may retain a temporary indicator while their removed objects are shown.

Hide only the visual marker for the root scope of `main`, which serves as the entry point. Preserve its variables, pointers, arrays, and structs; also preserve markers and data for its nested scopes and for other functions. The root scope's accessible identity must remain available even when its marker is not drawn.

The viewer retains Minimal, Normal, and Debug modes and Previous/Next history. Addresses and values use monospace type; metadata has lower visual priority. Change, pointer target, initialization, and scope-exit cues must remain clearly legible, including when focused, and must not rely on color alone. Cell sizes and inspection limits remain those defined by the code and engine API.

## References

This guide replaces the historical px0 record, which is no longer used.
