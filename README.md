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

## Credits

The Button and Theme Switch components and motion presets were adapted from [Arc UI](https://uiarc.dev) by Elia Kuratli. [MIT License](public/licenses/arc-ui.txt) (on the published site: `/licenses/arc-ui.txt`).

Pedagogical model for the Memory Viewer: [Alfredo Paz Valderrama](https://github.com/alfredopaz), Universidad Nacional de San Agustín de Arequipa.

## License

This project is distributed under the [MIT License](LICENSE).
