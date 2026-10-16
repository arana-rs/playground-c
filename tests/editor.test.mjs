import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEditorCommand,
  evaluateEditorCommand,
  evaluateNativeEdit,
  getCursorPosition,
  reconcileNativeEdit,
} from '../src/editor/operations.ts';
import { createEditorHistory } from '../src/editor/history.ts';
import {
  EDITOR_LINE_LIMIT_MESSAGE,
  MAX_EDITOR_LINES,
  getEditorLineCount,
  getEditorLineLimitDiagnostic,
  isEditorTextWithinLineLimit,
  normalizeEditorText,
} from '../src/editor/limits.ts';

const snapshot = (text = '', start = text.length, end = start, direction = 'none', pairs = []) => ({
  text,
  selection: { start, end, direction },
  pairs,
});

// Model the browser's literal edit when the command deliberately delegates to it.
function edit(before, command) {
  const handled = applyEditorCommand(before, command);
  if (handled) return handled;

  const { start, end } = before.selection;
  const deletionStart = command.type === 'backspace' && start === end ? Math.max(0, start - 1) : start;
  const inserted = command.type === 'type' ? command.character : '';
  const text = before.text.slice(0, deletionStart) + inserted + before.text.slice(end);
  const caret = deletionStart + inserted.length;
  return reconcileNativeEdit(before, text, { start: caret, end: caret, direction: 'none' });
}

const type = (before, character) => edit(before, { type: 'type', character });
const select = (before, start, end = start, direction = 'none') => ({
  ...before,
  selection: { start, end, direction },
});
const assertCaret = (state, position) => {
  assert.equal(state.selection.start, position);
  assert.equal(state.selection.end, position);
};

test('the shared editor line count normalizes CRLF and counts empty and trailing lines', () => {
  assert.equal(MAX_EDITOR_LINES, 999);
  assert.equal(getEditorLineCount(''), 1);
  assert.equal(getEditorLineCount('code\n'), 2);
  assert.equal(getEditorLineCount('code\r\n'), 2);
  assert.equal(normalizeEditorText('one\r\ntwo\rthree'), 'one\ntwo\nthree');
  assert.equal(getEditorLineCount('one\r\ntwo\rthree'), 3);

  const lines998 = Array.from({ length: 998 }, (_, index) => `line ${index}`).join('\n');
  const lines999 = `${lines998}\nline 998`;
  const lines1000 = `${lines999}\nline 999`;
  assert.equal(getEditorLineCount(lines998), 998);
  assert.equal(getEditorLineCount(lines999), 999);
  assert.equal(getEditorLineCount(lines1000), 1000);
  assert.equal(isEditorTextWithinLineLimit(lines998), true);
  assert.equal(isEditorTextWithinLineLimit(lines999), true);
  assert.equal(isEditorTextWithinLineLimit(lines1000), false);
  assert.match(getEditorLineLimitDiagnostic(lines1000), /no se cargó.*1000.*999/i);
  assert.equal(getEditorLineLimitDiagnostic(lines999), null);
  assert.match(EDITOR_LINE_LIMIT_MESSAGE, /999 líneas por archivo/);
});

test('Enter admits line 999, rejects line 1000, and allows replacing a 999-line selection', () => {
  const lines998 = Array.from({ length: 998 }, () => 'x').join('\n');
  const lines999 = `${lines998}\nx`;

  const exactLimit = evaluateEditorCommand(snapshot(lines998), { type: 'enter' });
  assert.equal(exactLimit.status, 'applied');
  assert.equal(getEditorLineCount(exactLimit.snapshot.text), 999);

  const overflow = evaluateEditorCommand(snapshot(lines999), { type: 'enter' });
  assert.equal(overflow.status, 'line-limit');
  assert.equal(getEditorLineCount(overflow.snapshot.text), 1000);
  assert.equal(applyEditorCommand(snapshot(lines999), { type: 'enter' }), null);

  const replacement = evaluateEditorCommand(snapshot(lines999, 0, lines999.length), { type: 'enter' });
  assert.equal(replacement.status, 'applied');
  assert.equal(replacement.snapshot.text, '\n');
  assert.equal(getEditorLineCount(replacement.snapshot.text), 2);
});

test('native paste or replacement is validated as a whole after replacing the selection', () => {
  const lines998 = Array.from({ length: 998 }, () => 'x').join('\n');
  const acceptedText = `${lines998}\nlast`;
  const rejectedText = `${acceptedText}\nextra`;
  const before = snapshot(lines998);

  const accepted = evaluateNativeEdit(before, acceptedText, {
    start: acceptedText.length,
    end: acceptedText.length,
    direction: 'none',
  });
  assert.equal(accepted.status, 'applied');
  assert.equal(getEditorLineCount(accepted.snapshot.text), 999);

  const rejected = evaluateNativeEdit(accepted.snapshot, `${rejectedText}\nmore`, {
    start: rejectedText.length + 5,
    end: rejectedText.length + 5,
    direction: 'none',
  });
  assert.equal(rejected.status, 'line-limit');
  assert.equal(getEditorLineCount(rejected.snapshot.text), 1001);

  const source = Array.from({ length: 999 }, (_, index) => `line ${index}`).join('\n');
  const lineStarts = [0];
  let nextLine = source.indexOf('\n');
  while (nextLine !== -1) {
    lineStarts.push(nextLine + 1);
    nextLine = source.indexOf('\n', nextLine + 1);
  }
  const start = lineStarts[200];
  const end = lineStarts[400];
  const inserted = 'short\nreplacement\n';
  const expectedText = source.slice(0, start) + inserted + source.slice(end);
  const selectionBefore = snapshot(source, start, end, 'forward');
  const replacement = evaluateNativeEdit(selectionBefore, expectedText, {
    start: start + inserted.length,
    end: start + inserted.length,
    direction: 'none',
  });
  assert.equal(replacement.status, 'applied');
  assert.equal(replacement.snapshot.text, expectedText);
  assert.ok(getEditorLineCount(replacement.snapshot.text) < MAX_EDITOR_LINES);
  assertCaret(replacement.snapshot, start + inserted.length);

  const history = createEditorHistory(selectionBefore);
  history.record(selectionBefore, replacement.snapshot);
  const undone = history.undo(replacement.snapshot);
  assert.equal(undone?.text, source);
  assert.deepEqual(undone?.selection, selectionBefore.selection);
  const redone = history.redo(undone);
  assert.equal(redone?.text, expectedText);
  assert.deepEqual(redone?.selection, replacement.snapshot.selection);
});

test('native reconciliation normalizes CRLF and maps the browser selection to LF offsets', () => {
  const raw = 'alpha\r\nbeta\r\n';
  const result = evaluateNativeEdit(snapshot('alpha'), raw, {
    start: raw.length,
    end: raw.length,
    direction: 'none',
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.snapshot.text, 'alpha\nbeta\n');
  assertCaret(result.snapshot, 'alpha\nbeta\n'.length);
  assert.deepEqual(getCursorPosition(result.snapshot), { line: 3, column: 1 });
});

test('a rejected native edit leaves undo and redo history untouched', () => {
  const lines998 = Array.from({ length: 998 }, () => 'x').join('\n');
  const lines999 = `${lines998}\nx`;
  const lines1000 = `${lines999}\nx`;
  const initial = snapshot(lines998);
  const accepted = evaluateNativeEdit(initial, lines999, {
    start: lines999.length,
    end: lines999.length,
    direction: 'none',
  });
  assert.equal(accepted.status, 'applied');

  const history = createEditorHistory(initial);
  history.record(initial, accepted.snapshot);
  const undone = history.undo(accepted.snapshot);
  assert.equal(undone?.text, lines998);
  assert.equal(history.canRedo(), true);
  const beforeRejectedEdit = structuredClone(undone);

  const rejected = evaluateNativeEdit(undone, lines1000, {
    start: lines1000.length,
    end: lines1000.length,
    direction: 'none',
  });
  assert.equal(rejected.status, 'line-limit');
  assert.deepEqual(undone, beforeRejectedEdit);
  assert.equal(history.canRedo(), true);
  const redone = history.redo(undone);
  assert.equal(redone?.text, lines999);
  assert.equal(history.canUndo(), true);
});

test('each supported pair opens with the caret inside, skips its generated closer, and deletes as a unit', () => {
  for (const [opener, closer] of [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"]]) {
    const opened = type(snapshot(), opener);
    assert.equal(opened.text, opener + closer);
    assertCaret(opened, 1);
    assert.equal(opened.pairs.length, 1);

    const closed = type(opened, closer);
    assert.equal(closed.text, opener + closer);
    assertCaret(closed, 2);

    const erased = edit(opened, { type: 'backspace' });
    assert.equal(erased.text, '');
    assertCaret(erased, 0);
    assert.equal(erased.pairs.length, 0);
  }
});

test('wrapping a backward multiline selection keeps its contents selected in the same direction', () => {
  const wrapped = type(snapshot('first\nsecond', 0, 12, 'backward'), '(');
  assert.equal(wrapped.text, '(first\nsecond)');
  assert.deepEqual(wrapped.selection, { start: 1, end: 13, direction: 'backward' });
  assert.equal(wrapped.pairs.length, 1);
});

test('manually entered pairs keep literal typing and Backspace behavior', () => {
  assert.equal(applyEditorCommand(snapshot(')', 0), { type: 'type', character: ')' }), null);
  assert.equal(type(snapshot(')', 0), ')').text, '))');
  assert.equal(edit(snapshot('{}', 1), { type: 'backspace' }).text, '}');
});

test('nested generated pairs retain their own closing positions while their content changes', () => {
  let state = type(snapshot(), '{');
  state = type(state, '[');
  state = type(state, '(');
  state = type(state, 'x');
  assert.equal(state.text, '{[(x)]}');
  assert.equal(state.pairs.length, 3);
  for (const closer of [')', ']', '}']) state = type(state, closer);
  assert.equal(state.text, '{[(x)]}');
  assertCaret(state, 7);
});

test('wrapping an existing generated pair preserves the inner pair behavior', () => {
  const inner = type(snapshot(), '(');
  const wrapped = type(select(inner, 0, 2, 'backward'), '[');
  assert.equal(wrapped.text, '[()]');
  assert.equal(wrapped.pairs.length, 2);
  const closedInner = type(select(wrapped, 2), ')');
  assert.equal(closedInner.text, '[()]');
  assertCaret(closedInner, 3);
  const closedOuter = type(closedInner, ']');
  assert.equal(closedOuter.text, '[()]');
  assertCaret(closedOuter, 4);
});

test('native insertion before a generated pair shifts its metadata, while deleting a delimiter invalidates it', () => {
  const opened = type(snapshot(), '(');
  const shifted = reconcileNativeEdit(opened, 'prefix ()', { start: 7, end: 7, direction: 'none' });
  assert.equal(shifted.pairs.length, 1);
  const closed = type(select(shifted, 8), ')');
  assert.equal(closed.text, 'prefix ()');
  assertCaret(closed, 9);

  const deleted = reconcileNativeEdit(opened, '(', { start: 1, end: 1, direction: 'none' });
  assert.equal(deleted.pairs.length, 0);
});

test('pasting delimiters is literal and does not invent generated pairs', () => {
  const pasted = '{}[]()""\'\'';
  const state = reconcileNativeEdit(snapshot(), pasted, {
    start: pasted.length,
    end: pasted.length,
    direction: 'none',
  });
  assert.equal(state.text, pasted);
  assert.equal(state.pairs.length, 0);

  const opened = type(snapshot(), '(');
  const innerPaste = reconcileNativeEdit(opened, '([])', { start: 3, end: 3, direction: 'none' });
  assert.equal(innerPaste.pairs.length, 1);
  assert.equal(edit(select(innerPaste, 2), { type: 'backspace' }).text, '(])');
});

test('C strings, character literals, and comments suppress automatic pairs', () => {
  for (const [text, character] of [
    ['// comment ', '('],
    ['/* comment ', '"'],
    ['"inside a string ', '['],
    ["'character", '{'],
    ['// continued \\\n', '('],
    ['"continued \\\n', '['],
    ['/\\\n* block comment ', '('],
  ]) {
    const before = snapshot(text);
    assert.equal(applyEditorCommand(before, { type: 'type', character }), null, JSON.stringify(text));
    const after = type(before, character);
    assert.equal(after.text, text + character);
    assert.equal(after.pairs.length, 0);
  }
  assert.equal(type(snapshot('// finished\n'), '(').text, '// finished\n()');
  assert.equal(type(snapshot('/* finished */ '), '[').text, '/* finished */ []');
});

test('escaped quotes insert literally, then the generated unescaped closing quote is skipped', () => {
  for (const quote of ['"', "'"]) {
    let state = type(snapshot(), quote);
    state = type(state, '\\');
    state = type(state, quote);
    assert.equal(state.text, quote + '\\' + quote + quote);
    assertCaret(state, 3);
    state = type(state, quote);
    assert.equal(state.text, quote + '\\' + quote + quote);
    assertCaret(state, 4);
  }
});

test('Enter preserves indentation and expands an empty block with a four-space inner line', () => {
  const continued = edit(snapshot('    return 1;'), { type: 'enter' });
  assert.equal(continued.text, '    return 1;\n    ');
  assertCaret(continued, continued.text.length);

  const emptyBlock = type(snapshot('    '), '{');
  const expanded = edit(emptyBlock, { type: 'enter' });
  assert.equal(expanded.text, '    {\n        \n    }');
  assertCaret(expanded, 14);
  const closed = type(select(expanded, expanded.text.length - 1), '}');
  assert.equal(closed.text, expanded.text);
  assertCaret(closed, expanded.text.length);
});

test('Enter after an opening C brace adds one level, while braces inside literals and comments keep their indentation', () => {
  const code = '    if (ready) {';
  const entered = edit(snapshot(code), { type: 'enter' });
  assert.equal(entered.text, code + '\n        ');
  assertCaret(entered, entered.text.length);
  for (const text of ['    "literal {', '    // {', '    /* {']) {
    const after = edit(snapshot(text), { type: 'enter' });
    assert.equal(after.text, text + '\n    ');
    assertCaret(after, after.text.length);
  }
});

test('Tab and Shift+Tab indent selected lines without including a line selected only at its start', () => {
  const before = snapshot('a\nb\nc', 0, 4, 'backward');
  const indented = edit(before, { type: 'indent', outdent: false });
  assert.equal(indented.text, '    a\n    b\nc');
  assert.equal(indented.selection.direction, 'backward');
  const restored = edit(indented, { type: 'indent', outdent: true });
  assert.equal(restored.text, before.text);
  assert.deepEqual(restored.selection, before.selection);

  const partialIndent = edit(snapshot('  a\n\tb\nc', 0, 7, 'forward'), { type: 'indent', outdent: true });
  assert.equal(partialIndent.text, 'a\nb\nc');
});

test('Tab inserts four spaces at a caret and Shift+Tab safely handles unindented lines', () => {
  const indented = edit(snapshot('ab', 1), { type: 'indent', outdent: false });
  assert.equal(indented.text, 'a    b');
  assertCaret(indented, 5);
  const unchanged = edit(snapshot('ab', 1), { type: 'indent', outdent: true });
  assert.equal(unchanged.text, 'ab');
  assertCaret(unchanged, 1);
});

test('an empty first line belongs to the document start during Enter and multiline indentation', () => {
  const entered = edit(snapshot('\nnext', 0), { type: 'enter' });
  assert.equal(entered.text, '\n\nnext');
  assertCaret(entered, 1);
  const indented = edit(snapshot('\nnext', 0, 1, 'forward'), { type: 'indent', outdent: false });
  assert.equal(indented.text, '    \nnext');
  assert.deepEqual(indented.selection, { start: 0, end: 5, direction: 'forward' });
});

test('line and column follow the active end of a selection and start at one', () => {
  assert.deepEqual(getCursorPosition(snapshot()), { line: 1, column: 1 });
  assert.deepEqual(getCursorPosition(snapshot('\nnext', 0)), { line: 1, column: 1 });
  assert.deepEqual(getCursorPosition(snapshot('ab\ncde\nf', 1, 6, 'forward')), { line: 2, column: 4 });
  assert.deepEqual(getCursorPosition(snapshot('ab\ncde\nf', 1, 6, 'backward')), { line: 1, column: 2 });
  assert.deepEqual(getCursorPosition(snapshot('a\n')), { line: 2, column: 1 });
});

test('commands and native reconciliation leave their input snapshots untouched', () => {
  const before = type(snapshot(), '(');
  const original = structuredClone(before);
  Object.freeze(before.selection);
  before.pairs.forEach(Object.freeze);
  Object.freeze(before.pairs);
  Object.freeze(before);
  type(before, 'x');
  edit(before, { type: 'backspace' });
  reconcileNativeEdit(before, '(paste)', { start: 6, end: 6, direction: 'none' });
  assert.deepEqual(before, original);
});
