# Browser Makefile subset

The browser build parser accepts a small, deterministic Makefile subset. It turns one supported compiler recipe into a logical build plan for the C engine. It does not run Make, a shell, or a native compiler, and it does not create an output file.

The parser API is:

```ts
parseMakefile(source: string, availableFileNames: readonly string[]): MakefileParseResult
```

The result contains either a `plan` (`target`, `entry`, and ordered `translationUnits`) or `null`, plus diagnostics. Each diagnostic uses `file: "Makefile"` and 1-based line and column positions in the original text. Results and their arrays are frozen copies.

## Supported example

```make
CC := cc
SOURCES := main.c util.c

app: $(SOURCES) util.h
	$(CC) $(SOURCES) -o $@
```

The recipe line must begin with one literal TAB in column 1. The first `.c` operand becomes `entry`; all `.c` operands, in recipe order, become `translationUnits`. The selected compiler target is `app`. The target and `-o` name must match.

The engine may find `main` in any translation unit. The parser does not inspect C source text to choose the entry file.

## Rules and prerequisites

- Blank lines and `#` comments are accepted. A comment begins at the first `#` on a line.
- A normal rule has one target: `target: prerequisites`. Multiple targets, double-colon rules, inline recipes, pattern rules, wildcards, order-only prerequisites, and target-specific assignments are unsupported.
- The first normal rule is the default goal. A simple rule without a recipe may aggregate dependencies, such as `all: app`; each reachable aggregation rule must resolve to exactly one compiler target.
- At most one compiler target may be reachable from the default goal. Missing prerequisites and dependency cycles produce diagnostics.
- Prerequisite names that match another target are followed as rules. Other prerequisites must appear in `availableFileNames`.
- `.c` and `.h` files may be prerequisites. Only `.c` files listed as compiler recipe operands become translation units. A `.h` recipe operand is an error; it is never silently removed from the command.
- `.PHONY: names...` is recognized so those names do not need to be workspace files. Since every browser run rebuilds the selected program, the directive does not enable timestamp behavior. Other special targets and Make variables are unsupported.
- Referenced logical names are relative, unquoted ASCII tokens made from letters, digits, `_`, `.`, `/`, and `-`. They cannot start with `/` or `-`, or contain empty, `.` or `..` path components.

## Variables

- Names contain letters, digits, and underscores, and start with a letter or underscore.
- `NAME = value` stores a recursively expanded value. `$(NAME)` is expanded when used, so references to variables defined later can resolve when the value is used.
- `NAME := value` expands immediately using variables defined up to that line, then stores the result.
- Undefined variable references expand to an empty string, matching GNU make behavior for ordinary undefined references. `CC` starts with the GNU make default value `cc`; a Makefile assignment can replace it.
- `$(NAME)` and the automatic variable `$@` are supported. `$@` expands to the current rule target in prerequisites and recipes; it is empty outside a target context.
- Variable cycles, unsupported Make functions, nested or computed references, `$$`, and automatic variables other than `$@` produce diagnostics. Duplicate variable definitions are unsupported.
- Prerequisites expand as their rule is read. Compiler recipes expand after the full Makefile has been read.

## Compiler recipes

A target may have one TAB-prefixed recipe containing one compiler invocation. The first argument must be the literal `cc`, `gcc`, or `clang`; it may be supplied through `$(CC)`. The remaining arguments may contain only:

- available `.c` source names; and
- exactly one `-o logical-target` pair whose target matches the rule.

Headers are prerequisite or include sources, not compiler operands. `.o` files and targets, other compiler flags, quoting, shell commands, redirections, operators, continuations, and additional recipe lines are unsupported and receive diagnostics. In particular, `$^` is unsupported: list the `.c` operands explicitly so headers are not passed to the compiler.

The `-o` name is only a logical target label for the build plan. No native executable or object file is produced. The browser rebuilds every Run; it does not implement timestamps, incremental builds, or object-file workflows.

## Unsupported features

Unsupported syntax is reported with a Makefile location rather than ignored. This includes included Makefiles; conditionals and other directives; special variables other than the limited `.PHONY` declaration; `+=`, `?=`, `!=`, and other assignment forms; functions such as `wildcard` and `shell`; shell syntax; quoted or escaped names; multiple targets or recipes; patterns and wildcards; and unknown compiler flags. `-D` and `-I` flags are not accepted because the browser engine has no corresponding compiler-option mapping.

The parser does not implement shell execution, environment or command-line variable overrides, built-in implicit rules, object files, native outputs, timestamps, or incremental builds. A Makefile is optional; the application integration decides when it is selected.

## Parser limits

To keep parsing bounded and deterministic, one Makefile is limited to 65,536 characters and 4,096 lines, 256 variables, 512 rules, 2,048 prerequisites per rule, and 2,048 available file names. An expanded value is limited to 32,768 characters, cumulative expansion to 262,144 characters, variable expansion depth to 32, and dependency depth to 128. At most 128 diagnostics are returned. These parser limits are separate from execution budgets.
