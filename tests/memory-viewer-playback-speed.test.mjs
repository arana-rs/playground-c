import assert from 'node:assert/strict';
import test from 'node:test';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';
import {
  DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS,
  MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS,
  MEMORY_VIEWER_PLAYBACK_SPEED_STORAGE_KEY,
  isMemoryViewerPlaybackInterval,
  readMemoryViewerPlaybackInterval,
  writeMemoryViewerPlaybackInterval,
} from '../src/memory/playbackSpeed.ts';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    values,
  };
}

test('playback speed options are a positive closed set with the configured default', () => {
  assert.deepEqual(MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS.map(option => option.intervalMs), [2_000, 1_000, 500, 250, 100]);
  assert.equal(DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS, RUN_CONFIGURATION.memoryViewer.playIntervalMs);
  for (const option of MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS) assert.equal(isMemoryViewerPlaybackInterval(option.intervalMs), true);
  for (const value of [0, -1, 50, 300, 500.5, Number.NaN, Number.POSITIVE_INFINITY, '500', null]) {
    assert.equal(isMemoryViewerPlaybackInterval(value), false);
  }
});

test('playback speed persists only exact recommended intervals and falls back on invalid storage', () => {
  const storage = createStorage();
  assert.equal(readMemoryViewerPlaybackInterval(storage), DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS);

  for (const option of MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS) {
    assert.equal(writeMemoryViewerPlaybackInterval(storage, option.intervalMs), true);
    assert.equal(storage.values.get(MEMORY_VIEWER_PLAYBACK_SPEED_STORAGE_KEY), String(option.intervalMs));
    assert.equal(readMemoryViewerPlaybackInterval(storage), option.intervalMs);
  }

  for (const invalid of ['0', '50', '300', '500.0', '0500', 'Infinity', '']) {
    storage.values.set(MEMORY_VIEWER_PLAYBACK_SPEED_STORAGE_KEY, invalid);
    assert.equal(readMemoryViewerPlaybackInterval(storage), DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS);
  }
  assert.equal(writeMemoryViewerPlaybackInterval(storage, 300), false);
  assert.equal(writeMemoryViewerPlaybackInterval(storage, 0), false);
});

test('unavailable playback speed storage leaves the configured default usable', () => {
  const getterThrows = () => { throw new Error('storage unavailable'); };
  const methodThrows = {
    getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); },
  };
  assert.equal(readMemoryViewerPlaybackInterval(getterThrows), DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS);
  assert.equal(readMemoryViewerPlaybackInterval(methodThrows), DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS);
  assert.equal(writeMemoryViewerPlaybackInterval(getterThrows, 250), false);
  assert.equal(writeMemoryViewerPlaybackInterval(methodThrows, 250), false);
});
