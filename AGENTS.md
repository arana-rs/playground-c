# AGENTS.md

## Working practices

- Reuse existing components, hooks, and functions before creating new ones.
- Keep a single source of truth for logic, constants, and configuration.
- Preserve existing user changes.
- Communicate progress and results to the user in Spanish.
- Write project code and project-authored documentation, including Markdown, in English. This includes identifiers, comments, and internal messages. When creating or changing UI text, use the existing ENG/SPA catalog; keep C technical terms and diagnostics in English, and show program output exactly as emitted. Never automatically translate user code or data. Keep user-facing progress and results and commit titles and bodies in Spanish, as specified below.

## Subagents

- The main agent primarily acts as an orchestrator and delegates all operational tasks to subagents: research and code inspection, implementation, documentation, tests and builds, browser navigation and debugging, code review, and requested Git operations.
- For each subagent, explicitly select model `gpt-6-luna` and reasoning effort `max`; do not inherit the main agent's model or effort.
- The main agent clarifies objectives, divides the work, assigns and coordinates tasks, tracks progress, and consolidates results for the user.
- Give each subagent brief, task-specific context; avoid passing the full history when it is not needed.

## Architecture

- The C engine lives in `packages/c11-engine` and is independent of React.
- The core must not import DOM, File, Worker, or filesystem APIs.
- Share the C scanner across the engine, syntax highlighting, and editor context.
- Preserve BigInt for LP64 integers and profile conversions.
- Run editor code inside the Worker.
- Reuse `RUN_CONFIGURATION` for execution budgets.

## Editor and design

- Follow `docs/STYLE.md` for visual changes and preserve the project's compact UI.
- Support GitHub Dark and GitHub Light themes, with matching syntax colors and a persisted preference.
- Reuse Arc's Button for Run/Stop.
- Stop must remain enabled during execution.
- Preserve selection, history, indentation, delimiter pairs, and IME composition.
- The initial example lives in `src/examples/main.c`; do not duplicate it.
- Rerenders and Run must preserve the user's edits.
- In Memory Viewer, Stack grows to the right and scopes appear when entered. Hide only the root scope marker for `main`; preserve its variables, nested scopes, and scopes from other functions. Use yellow for the current scope and a paler shade for earlier scopes.

## Engine and phases

- Consult `docs/c11-engine-roadmap.md` when expanding capabilities.
- Consult `packages/c11-engine/README.md` for the API and semantics.
- An unimplemented function must produce an explicit diagnostic.
- When adding capabilities, update tests, CAPABILITIES, and documentation.

## Commands and validation

- Development: `pnpm dev --host 0.0.0.0 --port 5173 --strictPort`
- Tests: `pnpm test`
- Build and TypeScript: `pnpm build`
- Choose checks appropriate to the change.
- Before creating a commit that adds or modifies fixtures or native P1–P5 oracles, run `pnpm test:ci`; it requires GCC and Clang and runs the suite on Ubuntu 24. Compare its printed versions with CI because `ubuntu-24.04` does not pin every tool version.
- For editor changes, check editing, undo, and redo.
- For execution changes, check Run, Stop, and diagnostics.
- Complete builds before browser testing because rebuilding the engine can cause Vite reloads.
- When creating a requested commit, include only changes from that task.

## Commit messages

- Use Conventional Commits in the format `type(scope): brief description in Spanish`. The types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, and `chore`, in lowercase and in English.
- The scope is optional and should match the change; common examples include `engine`, `editor`, `memory-viewer`, `license`, `release`, and `deps`, but other scopes may be used when appropriate.
- Write a short title with a direct imperative verb, without emoji or a final period.
- Always add a Spanish body on a new paragraph after the title, with a somewhat more detailed description of the change; it may explain its reason or impact.
- Mark breaking changes with `!` after the type or scope, or use the `BREAKING CHANGE:` footer to describe them.
- Example:
  ```text
  fix(memory-viewer): alinea las celdas de los structs

  Ajusta la disposición de las celdas para que cada campo del struct se lea correctamente.
  ```
- This convention does not authorize creating commits without a user request.
