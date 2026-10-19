import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCalculateCompletion,
  getCompletionKeyAction,
  isCompletionCaretVisible,
  isEditorCompositionEvent,
} from '../src/editor/completionInteractions.ts';

test('completion navigation selects options while Enter accepts only an arrow-selected option', () => {
  assert.equal(getCompletionKeyAction('ArrowDown', true, false, false, false), 'move-next');
  assert.equal(getCompletionKeyAction('ArrowUp', true, false, false, false), 'move-previous');
  assert.equal(getCompletionKeyAction('ArrowDown', true, false, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('ArrowUp', true, false, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', true, false, false, false), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', true, true, false, false), 'accept');
  assert.equal(getCompletionKeyAction('Tab', true, false, false, false), 'accept');
  assert.equal(getCompletionKeyAction('Tab', true, false, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('Enter', true, true, false, true), 'pass-through');
  assert.equal(getCompletionKeyAction('Escape', true, false, false, false), 'dismiss');
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
