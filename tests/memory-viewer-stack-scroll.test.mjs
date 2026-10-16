import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeStackScrollFollowTarget,
  StackScrollFollowAnchor,
} from '../src/memory/stackScrollGeometry.ts';

test('recalculates the nearest target when the viewport shrinks after follow starts', () => {
  const beforeReflow = computeStackScrollFollowTarget({
    currentScrollLeft: 0,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 350,
    elementLeft: 320,
    elementRight: 460,
    margin: 12,
  });

  assert.equal(beforeReflow.scrollLeft, 122);
  assert.equal(beforeReflow.alreadyVisible, false);

  // The first animation frame moved 34px; a mobile viewport/layout change then narrowed the
  // scrollport while the target remained clipped. The next frame must use those live bounds.
  const afterReflow = computeStackScrollFollowTarget({
    currentScrollLeft: 34,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 280,
    elementLeft: 286,
    elementRight: 426,
    margin: 12,
  });

  assert.equal(afterReflow.scrollLeft, 192);
  assert.equal(afterReflow.alreadyVisible, false);
});

test('a retained target can be corrected when it becomes clipped after first being visible', () => {
  const initiallyVisible = computeStackScrollFollowTarget({
    currentScrollLeft: 0,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 350,
    elementLeft: 200,
    elementRight: 330,
    margin: 12,
  });

  assert.deepEqual(initiallyVisible, { scrollLeft: 0, alreadyVisible: true, canFit: true });

  const afterReflow = computeStackScrollFollowTarget({
    currentScrollLeft: 0,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 280,
    elementLeft: 200,
    elementRight: 330,
    margin: 12,
  });

  assert.deepEqual(afterReflow, { scrollLeft: 62, alreadyVisible: false, canFit: true });
});

test('a follow anchor survives visibility confirmation and consumes its callback only once', () => {
  const completed = [];
  const anchor = new StackScrollFollowAnchor('heap-id6', 12, visible => completed.push(visible));
  const initial = anchor.plan({
    currentScrollLeft: 0,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 350,
    elementLeft: 200,
    elementRight: 330,
  });

  assert.deepEqual(initial, { scrollLeft: 0, alreadyVisible: true, canFit: true });
  assert.deepEqual(completed, [true]);
  assert.equal(anchor.isActive, true);

  const afterReflow = anchor.plan({
    currentScrollLeft: 0,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 280,
    elementLeft: 200,
    elementRight: 330,
  });
  assert.deepEqual(afterReflow, { scrollLeft: 62, alreadyVisible: false, canFit: true });
  anchor.plan({
    currentScrollLeft: 62,
    maxScrollLeft: 240,
    visibleLeft: 0,
    visibleRight: 280,
    elementLeft: 138,
    elementRight: 268,
  });
  anchor.cancel();

  assert.deepEqual(completed, [true]);
  assert.equal(anchor.isActive, false);
});

test('does not move a new block that is already visible between neighboring cards', () => {
  const target = computeStackScrollFollowTarget({
    currentScrollLeft: 0,
    maxScrollLeft: 120,
    visibleLeft: 13,
    visibleRight: 362,
    elementLeft: 173,
    elementRight: 313,
    margin: 12,
  });

  assert.deepEqual(target, { scrollLeft: 0, alreadyVisible: true, canFit: true });
});

test('an oversized target is recognized as impossible to reveal in the current scrollport', () => {
  const target = computeStackScrollFollowTarget({
    currentScrollLeft: 0,
    maxScrollLeft: 120,
    visibleLeft: 0,
    visibleRight: 200,
    elementLeft: 20,
    elementRight: 240,
    margin: 12,
  });

  assert.equal(target.canFit, false);
});

test('an oversized follow keeps its initial nearest edge instead of alternating sides per frame', () => {
  const anchor = new StackScrollFollowAnchor('wide-card', 12);
  const initial = anchor.plan({
    currentScrollLeft: 0,
    maxScrollLeft: 120,
    visibleLeft: 0,
    visibleRight: 200,
    elementLeft: 20,
    elementRight: 240,
  });

  assert.equal(initial?.scrollLeft, 52);
  assert.equal(anchor.canFit, false);

  // After moving 20px, a fresh stateless calculation would choose the opposite edge (8px).
  // The anchor holds 52px until layout invalidation or follow completion instead.
  const nextFrame = anchor.plan({
    currentScrollLeft: 20,
    maxScrollLeft: 120,
    visibleLeft: 0,
    visibleRight: 200,
    elementLeft: 0,
    elementRight: 220,
  });

  assert.equal(nextFrame, null);
  assert.equal(anchor.scrollLeftTarget, 52);
  anchor.cancel();
});
