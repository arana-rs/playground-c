import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCalculateCompletion,
  getCompletionKeyAction,
  isCompletionCaretVisible,
  isEditorCompositionEvent,
} from '../src/editor/completionInteractions.ts';
import { getCompletionSuggestions } from '../src/editor/completionProvider.ts';
import { evaluateEditorCommand, evaluateEditorTextReplacement } from '../src/editor/operations.ts';

test('completion navigation selects options while Enter and Tab accept the active option', () => {
  assert.equal(getCompletionKeyAction('ArrowDown', true, false, false), 'move-next');
  assert.equal(getCompletionKeyAction('ArrowUp', true, false, false), 'move-previous');
  assert.equal(getCompletionKeyAction('ArrowDown', true, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('ArrowUp', true, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', true, false, false), 'accept');
  assert.equal(getCompletionKeyAction('Tab', true, false, false), 'accept');
  assert.equal(getCompletionKeyAction('Tab', true, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', true, true, false), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', true, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', false, false, false), 'pass-through');
  assert.equal(getCompletionKeyAction('Escape', true, false, false), 'dismiss');
});

test('Enter accepts the active include suggestion without adding a newline', () => {
  const text = '#incl';
  const result = getCompletionSuggestions({ source: text, cursorOffset: text.length, trigger: 'automatic' });
  assert.ok(result);
  assert.deepEqual(result.options, ['include ']);
  assert.equal(getCompletionKeyAction('Enter', true, false, false), 'accept');

  const accepted = evaluateEditorTextReplacement({
    text,
    selection: { start: text.length, end: text.length, direction: 'none' },
    pairs: [],
  }, result.replaceStart, result.replaceEnd, result.options[0]);
  assert.equal(accepted?.status, 'applied');
  assert.equal(accepted?.snapshot.text, '#include ');
  assert.equal(accepted?.snapshot.selection.start, 9);
});

test('Enter without an active completion passes through to normal newline insertion', () => {
  const text = 'int value;';
  const action = getCompletionKeyAction('Enter', false, false, false);
  assert.equal(action, 'pass-through');

  const entered = evaluateEditorCommand({
    text,
    selection: { start: text.length, end: text.length, direction: 'none' },
    pairs: [],
  }, { type: 'enter' });
  assert.equal(entered.status, 'applied');
  assert.equal(entered.snapshot.text, 'int value;\n');
  assert.equal(entered.snapshot.selection.start, entered.snapshot.text.length);
});

test('completion closes when scrolling moves its caret outside the editor viewport', () => {
  const caret = { left: 100, top: 1289, lineHeight: 21 };
  const viewport = {
    scrollTop: 839.5,
    scrollLeft: 0,
    clientHeight: 469,
    clientWidth: 200,
  };
  assert.equal(isCompletionCaretVisible(caret, viewport), true);
  assert.equal(isCompletionCaretVisible(caret, { ...viewport, scrollTop: 849 }), true);
  assert.equal(isCompletionCaretVisible(caret, { ...viewport, scrollTop: 0 }), false);
  assert.equal(isCompletionCaretVisible(caret, { ...viewport, scrollTop: 1310 }), false);
  assert.equal(isCompletionCaretVisible(caret, { ...viewport, scrollLeft: 101 }), false);
  assert.equal(isCompletionCaretVisible({ ...caret, left: 200 }, viewport), false);
});

test('disabled, unfocused, selected, and composing editors do not calculate completions', () => {
  assert.equal(canCalculateCompletion(false, false, false, true), false);
  assert.equal(canCalculateCompletion(true, false, false, false), false);
  assert.equal(canCalculateCompletion(true, false, true, true), false);
  assert.equal(canCalculateCompletion(true, true, false, true), false);
  assert.equal(canCalculateCompletion(true, false, false, true), true);
  assert.equal(isEditorCompositionEvent({ isComposing: true, keyCode: 0 }, false), true);
  assert.equal(isEditorCompositionEvent({ isComposing: false, keyCode: 229 }, false), true);
  assert.equal(isEditorCompositionEvent({ isComposing: false, keyCode: 0 }, false), false);
});
