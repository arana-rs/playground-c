import assert from 'node:assert/strict';
import test from 'node:test';
import { getPlaygroundShortcut } from '../src/keyboardShortcuts.ts';

function keyEvent(overrides = {}) {
  return {
    key: 'x',
    code: 'KeyX',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    ...overrides,
  };
}

test('Run/Stop uses Ctrl+Enter on other platforms and Cmd+Enter on macOS', () => {
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', ctrlKey: true }), false), 'toggle-run');
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', metaKey: true }), true), 'toggle-run');
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', metaKey: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', ctrlKey: true }), true), null);
});

test('Ctrl+Backquote recognizes the printed key and the physical Backquote key', () => {
  assert.equal(getPlaygroundShortcut(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true }), false), 'toggle-console');
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Dead', code: 'Backquote', ctrlKey: true }), false), 'toggle-console');
  assert.equal(getPlaygroundShortcut(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true, altKey: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true, metaKey: true }), false), null);
});

test('global shortcuts ignore IME composition, legacy composition key codes, repeats, and handled events', () => {
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', ctrlKey: true, isComposing: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true, keyCode: 229 }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', ctrlKey: true, repeat: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true, defaultPrevented: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', ctrlKey: true, altKey: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'Enter', ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(getPlaygroundShortcut(keyEvent({ key: 'a', code: 'KeyA', ctrlKey: true }), false), null);
});
