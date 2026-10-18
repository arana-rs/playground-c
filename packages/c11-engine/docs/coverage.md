# C11 coverage

## Coverage in this version

### Preprocessing and literals

The engine supports C translation with object-like, function-like, and variadic macros; `#` and `##`; `#undef`, conditionals, includes from virtual files, trigraphs, line splicing, UCNs, and literal concatenation. `__VA_ARGS__` is accepted only as an identifier token in the replacement list of a variadic function-like macro. Stringification preserves preprocessing-token spelling, including a UCN such as `\u00E9`, while normalizing whitespace and escaping quotes and backslashes. UCNs that designate values below U+00A0 are rejected except U+0024 (`$`), U+0040 (`@`), and U+0060 (backtick); surrogate and out-of-range values are also rejected. An escaped backslash does not make following UCN-looking text a UCN, and ordinary `\x` escapes remain character escapes. Each translation unit has independent preprocessor state. Diagnostics retain their file and line after `#line` and includes. `#error`, supported STDC pragmas, `#pragma once`, and the predefined macros listed in `CAPABILITIES` are supported. Unknown non-STDC `#pragma` and `_Pragma` forms are ignored; malformed or unsupported STDC pragma forms retain their diagnostic. The feature-test macros `__STDC_NO_COMPLEX__`, `__STDC_NO_ATOMICS__`, and `__STDC_NO_THREADS__` are defined as `1`, indicating that these features are unsupported in this profile. `__STDC_NO_VLA__` is not defined while the profile implements VLA support; C11 defines no `__STDC_NO_IMAGINARY__` macro.

String literals are narrow `char` arrays with a terminating NUL. UCNs in ordinary narrow strings produce UTF-8 bytes; `u8` strings also encode raw Unicode source characters as UTF-8. String-literal array initialization accepts `char` and qualified `char` element types; an inferred bound includes the terminating NUL, while an explicit bound may omit it when the source characters fit. Raw non-ASCII source characters in unprefixed strings and wide literal prefixes are unsupported. A one-byte character constant follows the signed-`char` profile, so `'\xFF'` has value `-1`. Multi-character constants pack their bytes from left to right into `int`, retaining the low 32 bits: `'ab'` is `0x6162`, and `'abcde'` is `0x62636465`. `CAPABILITIES.stringLiteralProfile` and `CAPABILITIES.characterConstantProfile` publish these choices.

### Language semantics

The language profile covers bit-fields, padding, and flexible members; the `const`, `volatile`, and `restrict` qualifiers; `_Generic` selection; `_Alignas`, `_Alignof`, `_Static_assert`, `stdalign.h`, `offsetof`, and `max_align_t`; storage and linkage, block-scope `extern`, C11 `inline` semantics, and single-session `_Thread_local`; declarator and `typedef` composition; promotions, conversions, and function arguments; and object duration, representation, and effective type. `completeC11: false` indicates that the profile does not cover all of C11.

“Partial” describes coverage of a C11 feature family or header as a whole; the APIs published in `CAPABILITIES.stdioFunctions`, `CAPABILITIES.stdlibFunctions`, `CAPABILITIES.stringFunctions`, and `CAPABILITIES.timeFunctions` are implemented. The profile-specific limits and `Unplanned` areas are listed below. No standard-library header or C11 language family is complete, and the package does not claim full C11 conformance.

### Variable-length arrays and mathematical functions

The engine implements runtime `sizeof` for variable-length arrays and the real-valued C11 `math.h` API for `float`, `double`, and `long double`. This includes the function families, integer-returning and output-parameter functions, `nexttoward` mixed-format parameters, `float_t`/`double_t`, classification and comparison macros, and the required constants. The header reports `math_errhandling == MATH_ERRNO`; domain errors set `EDOM`, pole and range errors set `ERANGE`, and successful calls preserve `errno`. C11 leaves whether underflow sets `errno` to the implementation; this profile preserves it for exact zero and subnormal results and does not claim Annex F underflow behavior. Floating-point exception flags remain outside this profile with `<fenv.h>` listed as `Unplanned`. VLA fixtures cover nested dimensions, VLA type names and typedefs, pointer-to-VLA stride and operand effects, adjusted array parameters, and inspection of an active VLA's extent. Math fixtures cover result types, output parameters, comparison macro evaluation, binary80 values outside binary64 range, exact subnormals, domain/pole/range reporting, and fused multiply-add cases that distinguish one final rounding from intermediate rounding. GCC and Clang differential checks cover these behaviors.

The VLA subset retains C11 constraints on integer bounds, positive run-time lengths, block and prototype scope, linkage, storage duration, and initialization. VLA array objects cannot have static or thread storage duration, while pointers to VLA types may have static storage duration. A `goto` or `switch` transfer that would enter the scope of a variably modified declaration is diagnosed during preparation; transfers within that scope and transfers out of it remain supported. A backward `goto` that exits the VM scope and returns to a label before the declaration is valid; each execution of the declaration captures a new run-time bound and starts a new VLA lifetime. The real-valued math functions and macros published by `CAPABILITIES` cover the C11 `math.h` API for this profile; complex functions and type-generic dispatch through `<tgmath.h>` remain outside it. `math_errhandling` selects `MATH_ERRNO`; `<fenv.h>` and floating-point exception flags remain `Unplanned`. `fma`/`fmaf`/`fmal` compute the exact ternary result before one rounding to the result type. Other `long double` math results preserve binary80, but the profile does not promise correct rounding for every input or Annex F conformance.

### Declarators, types, and conversions

Declaration and conversion coverage is defined by this finite regression matrix; it does not claim to cover every C11 declaration or conversion.

| Area | Included cases | Published limit |
| --- | --- | --- |
| Declarators and compatible types | Tested composition of pointer, array, function, and function-pointer declarators; `typedef` aliases; incomplete arrays completed by an initializer; adjustment of array/function parameters to pointers; composite types for array and function declarations, including across translation units; rejection of incompatible types. | Completeness is checked by context: permitted declarations may retain incomplete types, while value uses that require completeness are diagnosed. Visibility covers the separate tag and ordinary identifier namespaces, typedef hiding, `for` scope, parameters, and prototype-scope tags. The profile does not cover the entire grammar or every diagnostic. |
| Promotions and conversions | Promotions of `_Bool`, small integer types, and enums to `int` in this profile; `float` to `double` in variadic or unprototyped calls; conversion of arguments to prototype parameters; signed and unsigned integer conversions under LP64; compatibility between prototypes and unprototyped declarations under the default promotions. | `f()` retains the meaning of a declaration with no parameter list, while `f(void)` declares zero parameters. The profile chooses `int` as the compatible integer type for enums; enumerators are `int` constants, but sharing that compatible type does not make distinct enum types compatible with each other. These rules do not imply universal detection of undefined behavior. |

Array, function, pointer, alias, and compatibility limits are tested in `../tests/p5-language.test.mjs`, `../tests/p5-language-extension.test.mjs`, and `../tests/p5-differential.test.mjs`. Typedef visibility and enums have dedicated regressions in `../tests/p5-language.test.mjs` and `../tests/p5-enum-types.test.mjs`. Differential oracles use GCC and Clang with `-std=c11 -pedantic-errors` for defined programs within the profile; see [GCC's documented standards modes](https://gcc.gnu.org/onlinedocs/gcc/Standards.html).

### Standard-library behavior

The profile includes the narrow APIs declared in `<stdio.h>`, the subsets of `<stdlib.h>` and `<string.h>` published in `CAPABILITIES.stdlibFunctions` and `CAPABILITIES.stringFunctions`, and ten `<time.h>` functions. The `<string.h>` API includes locale-independent `memchr`, which compares unsigned byte values, searches at most the first `n` bytes, and stops at the first match. The function list is shared by the virtual header and `CAPABILITIES.stringFunctions` through `src/core/string-metadata.ts`. Files and temporary files remain in the virtual filesystem; `freopen` preserves `FILE *` identity. In this profile, `freopen(NULL, mode, stream)` closes the previous stream, returns `NULL`, and sets `EINVAL` without selecting a new configuration. This is the option C11 permits when `filename` is null. `tmpfile` is removed when closed or when execution ends, and `fpos_t` is `long` with byte offsets. Streams default to `_IONBF`, preserving immediate output. `setvbuf` supports `_IOFBF`, `_IOLBF`, and `_IONBF` before any operation on the stream; buffered modes require a positive representable capacity. A non-null caller buffer is validated for a writable range, while the engine owns the actual pending-byte queue. `setbuf(NULL)` selects `_IONBF`, and a non-null buffer selects `_IOFBF` with `BUFSIZ` capacity. Full buffers flush at capacity; line-buffered streams also flush on newline and before a stdin read. `fflush`, close, repositioning, normal return, and `exit` after `atexit` handlers flush pending output. `quick_exit`, `_Exit`, `abort`, runtime errors, and cancellation do not automatically flush. The wide conversions `%lc`, `%ls`, and `%l[` remain explicitly rejected.

The bit-field profile is compared with GCC and Clang for the SysV x86-64 ABI. Plain `int` signedness, bit order, shared units, and zero-width barriers are profile choices, not universal C11 guarantees. Flexible members occupy the tail of an allocation, do not increase `sizeof`, and struct assignment copies only the fixed portion. Explicit alignments accept powers of two up to 65536 bytes; `malloc` provides 16-byte alignment. `max_align_t` has size 32 and alignment 16 on this target. TLS distinguishes storage duration and retains a single instance per session, with no concurrency model. Pointer-to-`uintptr_t` casts preserve known live virtual addresses according to the profile. `volatile` preserves its evaluations in the abstract machine. The dynamic `restrict` checker observes typed, byte-wise, and library accesses, including the exact ranges consumed by bounded string operations. It permits same-chain derivations and common pointer/integer round-trips, read-only access, no access, disjoint subobjects, and distinct bit-fields sharing a storage unit. Arbitrary integer transformations and integer values reconstructed from library text may lose tracked provenance. In that case, `RESTRICT_PROVENANCE_UNKNOWN` reports uncertainty only after an observed overlap with a restrict-based access and at least one modification; it does not assert a confirmed C violation. A known independent-base violation reports `RESTRICT_ALIAS`. The checker is dynamic and does not claim to detect every aliasing violation or all undefined behavior.

A project can have multiple translation units. Each unit is prepared with its own macro state, and the units are linked before execution. File-scope linkage (`static`), `extern`, `inline` functions, and K&R definitions are supported within the tested profile. External and tentative definitions are validated across units; object and macro state is not shared between units as though preprocessor state were global.

### Variadic functions and program entry

Variadic functions support the default promotions and `va_start`, `va_arg`, `va_copy`, and `va_end`. `va_arg` supports C11's corresponding signed/unsigned integer exception when the value is representable in both types, and retrieval between `void *` and a character pointer in either direction; unrelated types and values outside the common integer range are diagnosed. `main` supports `int main(void)`, parameterless `int main()`, and `int main(int, char **)`; the `argv` vector is complete, ends with a null pointer, and is configured per execution.

The 17 headers listed in `CAPABILITIES.virtualHeaders` are built-in virtual C sources, not copies from the host. Their coverage is partial. Tested subsets include `assert.h`, `ctype.h`, `errno.h`, `inttypes.h`, `iso646.h`, `stdarg.h`, `stdalign.h`, `stdio.h`, `stdlib.h`, `string.h`, and `time.h`, along with the numeric headers and `stddef.h`. `<stdalign.h>` defines `alignas`/`alignof` and the `__alignas_is_defined`/`__alignof_is_defined` macros; `<stddef.h>` provides `size_t`, `ptrdiff_t`, `offsetof`, and `max_align_t` as defined by the profile.

Narrow `<stdio.h>` coverage includes the 45 functions in `CAPABILITIES.stdioFunctions`: the `v*` families, virtual and temporary files, `freopen`, profile-specific buffering and `fgetpos`/`fsetpos` positions, as well as streams, EOF/error handling, binary input, and formatting. `scanf` floating conversions and `strtof`/`strtod` share direct target-format conversion for binary32/binary64; decimal inputs round to the nearest representable value with ties to even, and hexadecimal inputs convert from their exact rational value. `scanf` `%Lf` and `strtold` retain binary80 conversion. `printf` supports `%a`/`%A` for `double` and `long double`, and its decimal `%f`/`%e`/`%g` formatting uses exact rational rounding. Decimal precision is bounded by the existing `maxIOBytes` output budget and `maxInstructions` work budget, with no separate decimal precision cap; `%a`/`%A` retain a maximum precision of 100000 hexadecimal digits, as recorded in `CAPABILITIES.stdioFormatLimitations`. The wide conversions `%lc`, `%ls`, and `%l[` produce an explicit diagnostic and are outside this profile. `<stdlib.h>` provides narrow numeric conversions, allocation, search/sort, deterministic RNG, an empty virtual environment, and termination through the C scheduler; `system(NULL)` returns zero, and `system` with a command fails with `ENOSYS`. `<time.h>` uses UTC and retains the fixed instant `2024-01-01T00:00:00Z` when the core runs without host services; Run and Memory Viewer inject the Worker's actual clock. `time()` returns seconds, `timespec_get()` derives nanoseconds at millisecond resolution in those Workers, and `localtime` matches `gmtime`. No header family is complete.

`long double` uses binary80 in the x86-64 Linux profile, and its `%L` conversions preserve the exact value without going through `double`. `<wchar.h>`, `wchar_t`, `wint_t`, `WEOF`, the wide `<stdlib.h>` functions (`mbtowc`, `wctomb`, `mbstowcs`, `wcstombs`), and other wide-character APIs are listed as `Unplanned`. This profile includes bounded API and narrow-format support for `<stdio.h>`, `<time.h>`, and `<stdlib.h>`, as well as language declarators and types. The existing `ctype.h`/`string.h` functions under the C locale remain supported; configurable locales (`Unplanned`), `<wctype.h>`, complex and atomic language support (`_Complex`, `_Imaginary`, and `_Atomic`), `<complex.h>`, `<stdatomic.h>`, `<tgmath.h>`, `<threads.h>`, and virtual concurrency are `Unplanned`. Dynamic VLA `sizeof` and the real-valued `math.h` function set are supported for the target profile, with `MATH_ERRNO` reporting; floating-point exception flags and `<fenv.h>` remain `Unplanned`. Annexes F, G, and K may be evaluated separately; these optional evaluations carry no implementation commitment. Runtime atomic operations, concurrent TLS, and per-thread `errno` depend on the Unplanned concurrency work. Other capabilities outside the published profile are also `Unplanned`.

## C11 coverage reference

The references link to the official WG14 draft N1570. A `Partial` status means that the complete language family or header is not implemented. Profile notes record engine-specific behavior and limits. For standard behavior, consult the linked clause; for concrete API lists and runtime semantics, see the relevant package guide and exported `CAPABILITIES` object. No standard-library header is complete.

[N1570]: https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf

### Language families

| C11 area | Reference | Status and profile-specific coverage |
| --- | --- | --- |
| Program entry, arguments, and termination | [§§5.1.2.2.1, 5.1.2.2.3][N1570] | Partial. Supported main forms and the configured argument vector are in [Public entry points](runtime-api.md#public-entry-points); result status is in [Results, metrics, and limits](runtime-api.md#results-metrics-and-limits). |
| Translation constraints, diagnostics, and behavior | [§§4, 5.1.1.3][N1570] | Partial. Unsupported features produce explicit, location-bearing diagnostics. Undefined-behavior detection is finite. |
| Tokens, UCNs, constants, and string literals | [§§5.1.1.2, 6.4][N1570] | Partial. Narrow UCNs and u8 source characters encode as UTF-8; raw non-ASCII characters in unprefixed strings and wide literal prefixes are unsupported. Signed char and multicharacter choices are in [the literal profile](#coverage-in-this-version). |
| Includes and conditional inclusion | [§§6.10.1–6.10.2][N1570] | Partial. Includes resolve only within the virtual project and built-in headers; no host files are read. |
| Macro replacement | [§6.10.3][N1570] | Partial. Object-like, function-like, variadic, stringizing, token-pasting, and rescanning forms are supported within the preprocessor profile. |
| Line control, pragmas, and predefined macros | [§§6.10.4–6.10.9][N1570] | Partial. Each translation unit has independent preprocessor state; the profile publishes selected predefined macros. C11 defines no __STDC_NO_IMAGINARY__ macro. |
| Names, declarators, and compatible types | [§§6.2.1–6.2.8, 6.7][N1570] | Partial. The finite declaration/type matrix and incomplete-type cases are described under [Declarators, types, and conversions](#declarators-types-and-conversions). |
| Integer types, _Bool, and literals | [§§6.2.5–6.2.6, 6.4.4.1][N1570] | Partial. LP64 sizes and integer behavior are in [Numeric profile](numeric-profile.md); integers retain BigInt precision. |
| float/double types and literals | [§§6.2.5–6.2.6, 6.4.4.2][N1570] | Partial. Binary32/binary64 rounding and limits are in [Numeric profile](numeric-profile.md). |
| long double | [§§6.2.5–6.2.6, 6.4.4.2][N1570] | Implemented within this profile as x87 binary80 with 16-byte storage and alignment; this does not imply full C11 conformance. |
| Promotions, conversions, casts, and arguments | [§6.3][N1570] | Partial. The finite promotion/conversion matrix and enum identity rules are described under [Declarators, types, and conversions](#declarators-types-and-conversions). |
| Unary, postfix, and object access | [§6.5][N1570] | Partial. |
| Arithmetic, bitwise operations, and comparisons | [§6.5][N1570] | Partial. Detected signed overflow is diagnosed; unsigned arithmetic wraps modulo 2^N. |
| Short-circuit, conditional, comma, and sequencing | [§§5.1.2.3, 6.5][N1570] | Partial. Where C leaves operand order unspecified, this profile evaluates operands left to right; this does not permit unsequenced accesses. |
| Lvalues and assignment | [§§6.3.2.1, 6.5.16][N1570] | Partial. |
| Blocks, selection, and switch | [§§6.8.2, 6.8.4][N1570] | Partial. |
| Iteration statements | [§6.8.5][N1570] | Partial. |
| Labels and jump statements | [§§6.8.1, 6.8.6][N1570] | Partial. Invalid scope crossings are diagnosed within the implemented rules. |
| Function calls, parameters, and recursion | [§§6.5.2.2, 6.9.1][N1570] | Partial. |
| Function declarations and definitions | [§§6.7.6.3, 6.9.1][N1570] | Partial. Valid K&R function definitions are included in the tested profile. |
| Variadic functions | [§§6.5.2.2, 7.16][N1570] | Partial. `va_start`, `va_arg`, `va_copy`, and `va_end` are supported with default argument promotions and the two C11 `va_arg` compatibility exceptions described above. |
| Pointers, arithmetic, and conversions | [§§6.3.2.3, 6.5.6][N1570] | Partial. Addresses are virtual; pointer identity and provenance follow the published profile and live-object model. |
| Objects, duration, representation, and effective type | [§§6.2.4–6.2.6, 6.5][N1570] | Partial. TLS has one instance per session; effective-type and representation handling do not imply universal undefined-behavior detection. |
| Arrays, strings, and decay | [§§6.2.5, 6.4.5, 6.5.2.1][N1570] | Partial. Literal encoding and initialization limits are in [the literal profile](#coverage-in-this-version); VLA details are listed in [Variable-length arrays and mathematical functions](#variable-length-arrays-and-mathematical-functions). |
| Structures, unions, and anonymous members | [§6.7.2.1][N1570] | Partial. The bit-field ABI is the SysV x86-64 profile; flexible members use a dynamic allocation tail. |
| Enumerations and constant expressions | [§§6.6, 6.7.2.2][N1570] | Partial. Distinct enum types retain identity; the profile uses int as their compatible integer type and for enumerator constants. |
| Padding, bit-fields, and flexible members | [§6.7.2.1][N1570] | Partial. Field order, allocation units, plain-int signedness, and zero-width barriers follow the tested SysV x86-64 profile; sizeof and struct assignment omit the dynamic flexible-member tail. |
| Initialization and designators | [§6.7.9][N1570] | Partial. |
| Compound literals | [§6.5.2.5][N1570] | Partial. |
| const, volatile, and restrict | [§6.7.3][N1570] | Partial. volatile observes the abstract machine only. Dynamic restrict diagnostics cover observed modified overlaps; unresolved provenance reports RESTRICT_PROVENANCE_UNKNOWN, not a confirmed violation, while known independent associations report RESTRICT_ALIAS. |
| Storage classes, linkage, inline, and _Thread_local | [§§6.2.1–6.2.4, 6.7.1, 6.7.4][N1570] | Partial. TLS is per session; independent per-thread TLS and errno require the Unplanned concurrency model. _Noreturn is supported. |
| sizeof, alignment, and static assertions | [§§6.5, 6.7.5, 6.7.10][N1570] | Partial. Explicit alignment accepts powers of two through 65536 bytes; malloc provides 16-byte alignment; max_align_t is size 32/alignment 16. |
| Generic selection | [§6.5.1.1][N1570] | Partial. |
| Variable-length arrays, complex, and imaginary types | [§§6.2.5, 6.7.2, 6.7.6.2][N1570] | Partial. Runtime bounds and VLA sizeof are implemented for the published subset, and jumps that would enter variably modified scope are diagnosed; complex and imaginary language support is Unplanned. The profile does not define __STDC_NO_VLA__. |
| Atomic types and concurrent memory model | [§§5.1.2.4, 6.7.2.4, 7.17][N1570] | Unplanned. Atomic types and operations depend on virtual concurrency. |

### Standard-library headers

| Header | Reference | Status and profile-specific coverage |
| --- | --- | --- |
| &lt;assert.h&gt; | [§7.2][N1570] | Partial. It defines `static_assert` as `_Static_assert` and redefines `assert` on each inclusion according to the current `NDEBUG` state. |
| &lt;complex.h&gt; | [§7.3][N1570] | Unplanned; complex language support is also Unplanned in this profile. |
| &lt;ctype.h&gt; | [§7.4][N1570] | Partial under the C locale; configurable locales are Unplanned. |
| &lt;errno.h&gt; | [§7.5][N1570] | Partial. The execution model has no per-thread errno; that depends on virtual concurrency. |
| &lt;fenv.h&gt; | [§7.6][N1570] | Unplanned, including floating-point exception flags. |
| &lt;float.h&gt; | [§7.7][N1570] | Partial; reported limits match the binary32/binary64/binary80 profile. |
| &lt;inttypes.h&gt; | [§7.8][N1570] | Partial; published macros and functions follow the LP64 integer profile. |
| &lt;iso646.h&gt; | [§7.9][N1570] | Partial. |
| &lt;limits.h&gt; | [§7.10][N1570] | Partial; integer limits match the 8-bit-byte LP64 profile, and `MB_LEN_MAX` is 1 for the fixed C-locale profile. |
| &lt;locale.h&gt; | [§7.11][N1570] | Unplanned. Existing &lt;ctype.h&gt; and &lt;string.h&gt; behavior uses the C locale. |
| &lt;math.h&gt; | [§7.12][N1570] | Partial family; its real-valued function set is implemented for this profile with MATH_ERRNO. It does not promise Annex F conformance or universally correct rounding; &lt;fenv.h&gt; and complex math remain Unplanned. |
| &lt;setjmp.h&gt; | [§7.13][N1570] | Unplanned. |
| &lt;signal.h&gt; | [§7.14][N1570] | Unplanned. |
| &lt;stdalign.h&gt; | [§7.15][N1570] | Partial; alignment and availability macros are published. |
| &lt;stdarg.h&gt; | [§7.16][N1570] | Partial; variadic argument operations are described under [Variadic functions](#variadic-functions-and-program-entry). |
| &lt;stdatomic.h&gt; | [§7.17][N1570] | Unplanned; runtime ordering depends on virtual concurrency. |
| &lt;stdbool.h&gt; | [§7.18][N1570] | Partial. |
| &lt;stddef.h&gt; | [§7.19][N1570] | Partial; includes offsetof with member paths/constant subscripts and profile max_align_t. |
| &lt;stdint.h&gt; | [§7.20][N1570] | Partial; integer types and constants follow the LP64 profile. |
| &lt;stdio.h&gt; | [§7.21][N1570] | Partial; 45 narrow functions are published in CAPABILITIES.stdioFunctions. Files are virtual, default buffering is _IONBF, caller buffers are validated but the engine owns its queue, fpos_t uses long byte offsets, and %a/%A precision is capped at 100000 digits. Decimal work remains subject to I/O and instruction limits; wide conversions are Unplanned. Detailed API and I/O semantics are in [Input, output, and virtual files](runtime-api.md#input-output-and-virtual-files). |
| &lt;stdlib.h&gt; | [§7.22][N1570] | Partial; published functions use virtual memory, an empty virtual environment, deterministic RNG, and the C locale with `MB_CUR_MAX=1`. `mblen` accepts one-byte ASCII only. `system(NULL)` returns zero; commands fail with `ENOSYS`. Wide conversions are Unplanned. |
| &lt;stdnoreturn.h&gt; | [§7.23][N1570] | Unplanned. The language keyword _Noreturn is supported. |
| &lt;string.h&gt; | [§7.24][N1570] | Partial. The published byte and string functions include locale-independent `memchr`, which compares unsigned-byte values and reads sequentially through at most `n` bytes, stopping at the first match; configurable locale integration remains Unplanned. |
| &lt;tgmath.h&gt; | [§7.25][N1570] | Unplanned; type-generic complex dispatch depends on complex language/library support. |
| &lt;threads.h&gt; | [§7.26][N1570] | Unplanned; virtual threads, synchronization, and thread-specific storage are outside the session model. |
| &lt;time.h&gt; | [§7.27][N1570] | Partial with UTC only. The core defaults to 2024-01-01T00:00:00Z; an application can inject a clock per session. time uses seconds, timespec_get receives worker-clock millisecond precision, localtime equals gmtime, and clock scales virtual instructions by 1000. |
| &lt;uchar.h&gt; | [§7.28][N1570] | Unplanned. |
| &lt;wchar.h&gt; | [§7.29][N1570] | Unplanned; wchar_t, wint_t, WEOF, wide streams, and multibyte-wide conversions are not provided. |
| &lt;wctype.h&gt; | [§7.30][N1570] | Unplanned. |

### Unplanned

The following capabilities are `Unplanned` in this profile:

- **Complex and imaginary support:** _Complex, _Imaginary, &lt;complex.h&gt;, and &lt;tgmath.h&gt;.
- **Atomics and concurrency:** _Atomic, &lt;stdatomic.h&gt;, &lt;threads.h&gt;, and the virtual scheduler. Per-thread errno and independent TLS instances depend on this work.
- **Floating-point environment:** &lt;fenv.h&gt; and exception flags. Annex F remains a separate optional evaluation.
- **Locales:** &lt;locale.h&gt; and integration with &lt;ctype.h&gt;/&lt;string.h&gt;; current functions use the C locale.
- **Wide and Unicode character APIs:** &lt;uchar.h&gt;, &lt;wchar.h&gt;, &lt;wctype.h&gt;, wchar_t, wint_t, WEOF, wide stdio formats, and wide &lt;stdlib.h&gt; conversions.
- **Other headers:** &lt;setjmp.h&gt;, &lt;signal.h&gt;, and &lt;stdnoreturn.h&gt;; the language keyword _Noreturn remains supported.

Annexes F, G, and K may be evaluated separately; none carries an implementation commitment. Annex K's bounds-checking interfaces are not implemented. POSIX, GNU extensions, syscalls, ELF, assembly, and x86 instruction execution are outside this C11 profile.
