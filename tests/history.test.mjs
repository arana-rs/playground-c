import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditorHistory } from '../src/editor/history.ts';
import { applyEditorCommand, reconcileNativeEdit } from '../src/editor/operations.ts';

const snapshot = (text = '', position = text.length) => ({
  text,
  selection: { start: position, end: position, direction: 'none' },
  pairs: [],
});

test('ordinary contiguous typing is undone and redone as one group with the current cursor', () => {
  const initial = snapshot();
  const history = createEditorHistory(initial);
  const first = snapshot('a');
  const second = snapshot('ab');
  history.record(initial, first, { kind: 'typing', timestamp: 1000 });
  history.record(first, second, { kind: 'typing', timestamp: 1100 });
  const current = snapshot('ab', 1);
  assert.deepEqual(history.undo(current), initial);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);
  assert.deepEqual(history.redo(initial), current);
});

test('automatic actions restore the whole text, selection, and pair tracking in a single step', () => {
  const initial = snapshot();
  const history = createEditorHistory(initial);
  const opened = applyEditorCommand(initial, { type: 'type', character: '{' });
  assert.ok(opened);
  history.record(initial, opened, { kind: 'action', timestamp: 1000 });
  const expanded = applyEditorCommand(opened, { type: 'enter' });
  assert.ok(expanded);
  history.record(opened, expanded, { kind: 'action', timestamp: 1100 });
  assert.deepEqual(history.undo(expanded), opened);
  assert.deepEqual(history.undo(opened), initial);
  assert.deepEqual(history.redo(initial), opened);
  assert.deepEqual(history.redo(opened), expanded);
});

test('native edits after an automatic pair keep their own undo step and restore the generated closer', () => {
  const initial = snapshot();
  const history = createEditorHistory(initial);
  const opened = applyEditorCommand(initial, { type: 'type', character: '(' });
  assert.ok(opened);
  history.record(initial, opened, { kind: 'action', timestamp: 1000 });
  const typed = reconcileNativeEdit(opened, '(x)', { start: 2, end: 2, direction: 'none' });
  history.record(opened, typed, { kind: 'typing', timestamp: 1100 });
  const restored = history.undo(typed);
  assert.deepEqual(restored, opened);
  const closed = applyEditorCommand(restored, { type: 'type', character: ')' });
  assert.equal(closed.text, '()');
  assert.equal(closed.selection.start, 2);
  assert.deepEqual(history.redo(restored), typed);
});

test('contiguous Backspace edits share one undo group', () => {
  const initial = snapshot('abc');
  const history = createEditorHistory(initial);
  const first = snapshot('ab');
  const second = snapshot('a');
  history.record(initial, first, { kind: 'delete', timestamp: 1000 });
  history.record(first, second, { kind: 'delete', timestamp: 1100 });
  assert.deepEqual(history.undo(second), initial);
  assert.equal(history.canUndo(), false);
  assert.deepEqual(history.redo(initial), second);
});

test('explicit boundaries and typing pauses split groups, and a new edit discards redo', () => {
  const initial = snapshot();
  const history = createEditorHistory(initial);
  const first = snapshot('a');
  const second = snapshot('ab');
  const third = snapshot('abc');
  history.record(initial, first, { kind: 'typing', timestamp: 1000 });
  history.breakGroup();
  history.record(first, second, { kind: 'typing', timestamp: 1100 });
  history.record(second, third, { kind: 'typing', timestamp: 2000 });
  assert.deepEqual(history.undo(third), second);
  assert.deepEqual(history.undo(second), first);
  const replacement = reconcileNativeEdit(first, 'ax', { start: 2, end: 2, direction: 'none' });
  history.record(first, replacement, { kind: 'typing', timestamp: 2100 });
  assert.equal(history.canRedo(), false);
  assert.equal(history.redo(replacement), null);
});

test('history owns independent snapshot copies rather than live mutable references', () => {
  const initial = snapshot();
  const history = createEditorHistory(initial);
  const opened = applyEditorCommand(initial, { type: 'type', character: '(' });
  assert.ok(opened);
  const expected = structuredClone(opened);
  history.record(initial, opened, { kind: 'action' });
  initial.selection.start = 99;
  opened.pairs.length = 0;
  opened.selection.start = 0;
  const restoredInitial = history.undo(expected);
  assert.deepEqual(restoredInitial, snapshot());
  const restored = history.redo(restoredInitial);
  assert.deepEqual(restored, expected);
  restored.selection.start = 99;
  assert.deepEqual(history.undo(expected), snapshot());
  assert.deepEqual(history.redo(snapshot()), expected);
});
