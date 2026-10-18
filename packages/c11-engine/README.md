# @playground/c11-engine · C11 engine profile · 0.1.0

An incremental C engine for browsers and Node.js, targeting the x86-64 Linux LP64 profile. It interprets C in its own virtual machine; it does not compile or execute native instructions. The core does not depend on React, DOM, Worker, File, or the filesystem. The package **does not implement all of C11**: `CAPABILITIES` publishes the profile, and an out-of-scope capability produces an explicit diagnostic.

## Documentation

| Topic | Guide |
| --- | --- |
| C11 coverage, profile limits, and official clause references | [C11 coverage](docs/coverage.md) |
| LP64 types, conversions, and numeric precision | [Numeric profile](docs/numeric-profile.md) |
| Public API, execution, I/O, virtual files, and budgets | [Runtime API](docs/runtime-api.md) |
| Debug sessions, snapshots, and the application Memory Viewer | [Debugging](docs/debugging.md) |

`CAPABILITIES` is the published capability source. The guides describe its profile and runtime behavior; unsupported capabilities produce explicit diagnostics.

The narrow string API list lives in `src/core/string-metadata.ts` and supplies both the built-in `<string.h>` declarations and `CAPABILITIES.stringFunctions`.

## Development and validation

From the repository root:

```sh
pnpm --filter @playground/c11-engine build
pnpm --filter @playground/c11-engine test
pnpm test
```

The regression suite covers diagnostics, multiple translation units, layout, VLA runtime sizes and debug inspection, real-valued math functions, output parameters, `errno`, and fused multiply-add rounding. Native GCC/Clang comparisons cover defined finite programs under the LP64 profile. Differential tests use fixed programs and never execute editor text on the host. The published VLA subset does not complete the C11 family or imply full C11 conformance.
