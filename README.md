# c-playground-v2

Browser-based C playground with an editor, Worker-based execution, and a memory viewer.

```sh
pnpm install
pnpm dev --port 5173
pnpm build
```

## UI design

The normative guide for the project's compact UI is [STYLE.md](docs/STYLE.md).

The interface can switch between English (ENG) and Spanish (SPA). It saves the preference in the browser and defaults to English. The language setting affects only interface controls and help text: C engine diagnostics remain in English, and program output is shown exactly as emitted by the code.

## Workspace source files

The editor workspace can contain flat `.c` source files, `.h` header files, and an optional root `Makefile`. Create or rename source and header files from the file tab bar. Each virtual filename must be unique. If a stored workspace contains duplicate filenames, restoration assigns generated names to the later duplicates while preserving their file IDs and source text.

If the stored workspace declares an unsupported schema version, the app opens a read-only fallback and leaves the stored bytes untouched. `localStorage` has no transaction or compare-and-swap for the version check and write, so this protection cannot guarantee preservation against arbitrary simultaneous writers.

Without a `Makefile`, the selected `.c` file is the program entry and the only translation unit compiled by Run or Memory Viewer. With a valid `Makefile`, the workspace build plan selects its `.c` translation units, so Run, syntax analysis, and Memory Viewer use the same project even when another tab is active. V1 resolves this supported subset as virtual source selection; it does not invoke native `make`, a shell, or a compiler. The supported syntax and its limits are documented in [Makefile support](docs/makefile.md). An invalid Makefile reports its own file location and prevents Run or debug from falling back to the selected `.c` file. A selected `.h` remains editable and available to syntax analysis; Run and Memory Viewer require a valid project build plan.

Syntax analysis, Run, and Memory Viewer each receive an immutable snapshot of the origin document and all workspace files. Diagnostics and debug locations retain the filename and line from the source where they originated. The debug source panel follows the captured location across translation units, included files, and history without replacing the editor's current buffer. Workspace source files are separate from runtime `io.files`; adding a source file does not make it available to C file I/O such as `fopen`.

Structured source diagnostics in the console and related-location notes can open their captured workspace file at the reported position. Navigation follows the file's stable workspace ID across renames and uses the current editor contents when the source has changed.

## Credits

The Button and Theme Switch components and motion presets were adapted from [Arc UI](https://uiarc.dev) by Elia Kuratli. [MIT License](public/licenses/arc-ui.txt) (on the published site: `/licenses/arc-ui.txt`).

Pedagogical model for the Memory Viewer: [Alfredo Paz Valderrama](https://github.com/alfredopaz), Universidad Nacional de San Agustín de Arequipa.

## License

This project is distributed under the [MIT License](LICENSE).
