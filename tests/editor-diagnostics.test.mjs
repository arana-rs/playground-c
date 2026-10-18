import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupEditorDiagnosticsByLine,
  projectEditorDiagnosticGroups,
  projectEditorDiagnostics,
} from '../src/editor/editorDiagnostics.ts';

function diagnostic(overrides = {}) {
  return {
    code: 'PARSE_ERROR',
    message: 'Expected ;.',
    file: 'main.c',
    line: 1,
    column: 1,
    ...overrides,
  };
}

test('projects physical locations across tabs and CRLF, retaining the original diagnostic fields', () => {
  const source = '\tint x = ;\r\nint y = ;';
  const first = diagnostic({ column: 10 });
  const second = diagnostic({ line: 2, column: 9, message: 'Expected an expression.' });

  const projected = projectEditorDiagnostics(source, [first, second]);

  assert.deepEqual(projected.map(({ line, column, message, code, file, anchor }) => ({
    line, column, message, code, file, anchor,
  })), [
    { ...first, anchor: { line: 1, column: 10, length: 1 } },
    { ...second, anchor: { line: 2, column: 9, length: 1 } },
  ]);
  assert.equal(projected[0].id, projectEditorDiagnostics(source, [first, second])[0].id);
});

test('groups every diagnostic on a line while preserving duplicate locations and stable IDs', () => {
  const source = 'int x = ;';
  const diagnostics = [
    diagnostic({ column: 5, message: 'First parser error.' }),
    diagnostic({ column: 5, message: 'First parser error.' }),
    diagnostic({ column: 8, message: 'Second parser error.' }),
  ];

  const groups = projectEditorDiagnosticGroups(source, diagnostics);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].line, 1);
  assert.equal(groups[0].diagnostics.length, 3);
  assert.notEqual(groups[0].diagnostics[0].id, groups[0].diagnostics[1].id);
  assert.deepEqual(groupEditorDiagnosticsByLine(groups[0].diagnostics), groups);
});

test('drops locations outside the current file and source bounds', () => {
  const source = 'int x;\n';
  const projected = projectEditorDiagnostics(source, [
    diagnostic({ file: 'header.h' }),
    diagnostic({ line: 0 }),
    diagnostic({ line: 3 }),
    diagnostic({ column: 99 }),
    diagnostic({ column: 2.5 }),
  ]);

  assert.deepEqual(projected, []);
});

test('keeps EOF diagnostics as gutter markers without a text anchor', () => {
  const source = 'int x =';
  const projected = projectEditorDiagnostics(source, [diagnostic({ column: source.length + 1 })]);

  assert.equal(projected.length, 1);
  assert.equal(projected[0].anchor, null);
  assert.deepEqual(projectEditorDiagnosticGroups(source, [diagnostic({ column: source.length + 1 })]), [
    { line: 1, diagnostics: projected },
  ]);
});

test('does not split supplementary Unicode characters in a one-character anchor', () => {
  const source = 'int 𐐀 = ;';
  const projected = projectEditorDiagnostics(source, [diagnostic({ column: 6 })]);

  assert.deepEqual(projected[0].anchor, { line: 1, column: 5, length: 2 });
});

test('omits visual marks for #line remapping, including same-file, continued, digraph, and trigraph forms', () => {
  const diagnostics = [diagnostic({ column: 5 })];
  for (const source of [
    'int x = ;\n#line 1 "main.c"\nint y = ;',
    '#line \\\n 1 "main.c"\nint x = ;',
    '%:line 1 "main.c"\nint x = ;',
    '??=line 1 "main.c"\nint x = ;',
    '# /* comment */ line 1 "main.c"\nint x = ;',
  ]) {
    assert.deepEqual(projectEditorDiagnostics(source, diagnostics), [], source);
  }
});

test('does not confuse a split directive name with an unknown #line spelling', () => {
  const diagnostics = [diagnostic({ column: 1 })];
  for (const source of [
    '#lineage 1 "main.c"\nint x;',
    '# /* comment\n */ line 1 "main.c"\nint x;',
  ]) {
    assert.equal(projectEditorDiagnostics(source, diagnostics).length, 1, source);
  }
});

test('does not mistake #line text inside comments or string literals for a directive', () => {
  const source = '/* #line 9 "other.c" */ int x = ;\nconst char *text = "#line 20";';
  const semicolonColumn = source.slice(0, source.indexOf(';')).length + 1;
  const projected = projectEditorDiagnostics(source, [diagnostic({ column: semicolonColumn })]);

  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0].anchor, { line: 1, column: semicolonColumn, length: 1 });
});

test('projects exact primary and related ranges with UTF-16 columns, tabs, and CRLF', () => {
  const source = '\tconst char *label = "😀";\r\n\tint total = (10 + 5;';
  const projected = projectEditorDiagnostics(source, [diagnostic({
    line: 2,
    column: 21,
    endLine: 2,
    endColumn: 22,
    message: "Expected ')' before ';'.",
    related: [
      {
        message: "Opening '(' is here.",
        file: 'main.c',
        line: 2,
        column: 14,
        endLine: 2,
        endColumn: 21,
      },
      {
        message: 'Included source location.',
        file: 'header.h',
        line: 4,
        column: 3,
      },
    ],
  })]);

  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0].anchors, [{ line: 2, column: 21, length: 1 }]);
  assert.deepEqual(projected[0].relatedLocations.map(({ message, file, line, column, anchors }) => ({
    message, file, line, column, anchors,
  })), [
    {
      message: "Opening '(' is here.",
      file: 'main.c',
      line: 2,
      column: 14,
      anchors: [{ line: 2, column: 14, length: 7 }],
    },
    {
      message: 'Included source location.',
      file: 'header.h',
      line: 4,
      column: 3,
      anchors: [],
    },
  ]);
  assert.deepEqual(projectEditorDiagnosticGroups(source, [projected[0]]).map(group => group.line), [2]);
});

test('splits a multiline diagnostic into bounded line fragments without marking CRLF', () => {
  const source = 'int f = (\r\n\t10 +\r\n\t5;';
  const projected = projectEditorDiagnostics(source, [diagnostic({
    line: 2,
    column: 2,
    endLine: 3,
    endColumn: 4,
  })]);

  assert.deepEqual(projected[0].anchors, [
    { line: 2, column: 2, length: 4 },
    { line: 3, column: 1, length: 3 },
  ]);
  assert.deepEqual(projectEditorDiagnosticGroups(source, [diagnostic({
    line: 2,
    column: 2,
    endLine: 3,
    endColumn: 4,
  })]).map(group => group.line), [2, 3]);
});

test('expands range endpoints that split a supplementary Unicode character', () => {
  const source = 'int 😀x = 0;';
  const projected = projectEditorDiagnostics(source, [diagnostic({
    column: 5,
    endLine: 1,
    endColumn: 6,
  })]);

  assert.deepEqual(projected[0].anchors, [{ line: 1, column: 5, length: 2 }]);
});
