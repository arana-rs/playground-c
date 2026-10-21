import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDirectStdioInclude, hasStdioIncludeInWorkspace } from '../src/memory/stdioInclude.ts';

test('detects direct stdio.h includes with supported spacing, comments and line splices', () => {
  const sources = [
    '#include <stdio.h>',
    '  # include <stdio.h>',
    '/* leading */ # include /* header follows */ <stdio.h>',
    '#/* split directive */include\t"stdio.h"',
    '#include "stdio.h"',
    '#include \\\r\n<stdio.h>',
  ];

  for (const source of sources) assert.equal(hasDirectStdioInclude(source), true, source);
});

test('ignores directive-like text, unrelated headers, macro headers and following lines', () => {
  const sources = [
    '// #include <stdio.h>',
    '/* #include <stdio.h> */',
    'const char *text = "#include <stdio.h>";',
    '#include <stdlib.h>',
    '#include <stdio.h-extra>',
    '#include STDIO_HEADER',
    '#define TEXT "stdio.h"',
    '#include\n<stdio.h>',
    '#include\n"stdio.h"',
  ];

  for (const source of sources) assert.equal(hasDirectStdioInclude(source), false, source);
});

test('finds stdio.h in captured workspace sources while preserving single-file behavior', () => {
  const main = '#include "local.h"\nint main(void) { return 0; }';
  const localHeader = '#include "helper.c"';
  const helper = '#include <stdio.h>\nint read_value(void) { int value; return scanf("%d", &value); }';

  assert.equal(hasStdioIncludeInWorkspace([
    { source: main },
    { source: localHeader },
    { source: helper },
  ]), true, 'a transitive local include can introduce stdio.h');
  assert.equal(hasStdioIncludeInWorkspace([{ source: main }]), false,
    'a single source without stdio.h keeps the existing disabled-console behavior');
  assert.equal(hasStdioIncludeInWorkspace([
    { source: main },
    { source: '/* sibling not included by main */\n#include <stdio.h>' },
  ]), true, 'the captured-project scan is intentionally conservative for unused siblings');
});
