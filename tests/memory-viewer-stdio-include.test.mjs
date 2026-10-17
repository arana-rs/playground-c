import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDirectStdioInclude } from '../src/memory/stdioInclude.ts';

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
