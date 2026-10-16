import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampConsoleHeight,
  getConsoleHeightBounds,
  getEffectiveConsoleHeight,
  getInitialConsoleHeight,
  getVisibleViewportRect,
  getPlaygroundRows,
  hasKeyboardViewportRecovered,
  isKeyboardViewportShrunk,
  PLAYGROUND_ROW_HEIGHTS,
} from '../src/consoleLayout.ts';

test('console resize limits preserve useful editor space and the initial console takes one third of the shared panel', () => {
  const bounds = getConsoleHeightBounds(800);
  assert.equal(bounds.min, 48);
  assert.equal(bounds.max, 440);
  assert.equal(getInitialConsoleHeight(800), 235);
  assert.equal(getInitialConsoleHeight(350), 85);
  assert.equal(getInitialConsoleHeight(300), 68);
  assert.equal(clampConsoleHeight(999, bounds), bounds.max);
  assert.equal(clampConsoleHeight(1, bounds), bounds.min);

  const shortViewport = getConsoleHeightBounds(300);
  const remainingEditor = 300
    - PLAYGROUND_ROW_HEIGHTS.header
    - PLAYGROUND_ROW_HEIGHTS.tabs
    - PLAYGROUND_ROW_HEIGHTS.footer
    - PLAYGROUND_ROW_HEIGHTS.separator
    - shortViewport.max;
  assert.equal(remainingEditor, PLAYGROUND_ROW_HEIGHTS.minEditor);
});

test('stdin keyboard priority expands the effective console and restores the saved manual height afterward', () => {
  const preferredHeight = 110;
  const reducedViewportHeight = 360;
  const reducedBounds = getConsoleHeightBounds(reducedViewportHeight, true);
  const priorityHeight = getEffectiveConsoleHeight(preferredHeight, reducedViewportHeight, true);

  assert.equal(reducedBounds.max, 216);
  assert.equal(priorityHeight, reducedBounds.max);
  assert.ok(priorityHeight > getEffectiveConsoleHeight(preferredHeight, reducedViewportHeight, false));
  assert.equal(getEffectiveConsoleHeight(preferredHeight, reducedViewportHeight, true, true), preferredHeight);
  assert.equal(getEffectiveConsoleHeight(preferredHeight, 800, false), preferredHeight);
});

test('very short keyboard viewport keeps Run/Stop and gives the remaining height to console input', () => {
  const viewportHeight = 160;
  const rows = getPlaygroundRows(viewportHeight, true);
  const bounds = getConsoleHeightBounds(viewportHeight, true);
  const effectiveHeight = getEffectiveConsoleHeight(48, viewportHeight, true, true);

  assert.equal(rows.compactKeyboard, true);
  assert.equal(rows.header, 0);
  assert.equal(rows.tabs, PLAYGROUND_ROW_HEIGHTS.tabs);
  assert.equal(rows.editorMinimum, 0);
  assert.equal(rows.separator, 0);
  assert.equal(rows.footer, 0);
  assert.equal(effectiveHeight, bounds.max);
  assert.equal(rows.header + rows.tabs + rows.separator + effectiveHeight + rows.footer, viewportHeight);
  assert.ok(effectiveHeight >= 120);

  const recoveredHeight = 844;
  assert.equal(getEffectiveConsoleHeight(48, recoveredHeight, false), 48);
  assert.equal(getPlaygroundRows(192, true).compactKeyboard, false);
});

test('viewport priority requires focused stdin, a large height reduction, stable width, and no pinch zoom', () => {
  const base = {
    referenceHeight: 800,
    width: 390,
    referenceWidth: 390,
    scale: 1,
    stdinFocused: true,
  };

  assert.equal(isKeyboardViewportShrunk({ ...base, height: 600 }), true);
  assert.equal(isKeyboardViewportShrunk({ ...base, height: 700 }), false);
  assert.equal(isKeyboardViewportShrunk({ ...base, height: 600, stdinFocused: false }), false);
  assert.equal(isKeyboardViewportShrunk({ ...base, height: 600, scale: 1.5 }), false);
  assert.equal(isKeyboardViewportShrunk({ ...base, height: 600, width: 780 }), false);

  assert.equal(hasKeyboardViewportRecovered({ ...base, height: 700 }), true);
  assert.equal(hasKeyboardViewportRecovered({ ...base, height: 600 }), false);
  assert.equal(hasKeyboardViewportRecovered({ ...base, height: 600, scale: 1.5 }), false);
  assert.equal(hasKeyboardViewportRecovered({ ...base, height: 600, width: 780 }), true);
});

test('visible viewport measurements use the visual rectangle and fall back to layout dimensions', () => {
  assert.deepEqual(getVisibleViewportRect(390, 844, {
    width: 390,
    height: 420,
    offsetLeft: 0,
    offsetTop: 24,
    scale: 1,
  }), {
    width: 390,
    height: 420,
    left: 0,
    top: 24,
    scale: 1,
  });
  assert.deepEqual(getVisibleViewportRect(390, 844, { width: 0, height: 0 }), {
    width: 390,
    height: 844,
    left: 0,
    top: 0,
    scale: 1,
  });
});
