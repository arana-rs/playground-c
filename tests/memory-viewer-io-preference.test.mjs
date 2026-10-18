import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY,
  readMemoryViewerIoConsolePreference,
  writeMemoryViewerIoConsolePreference,
} from '../src/memory/ioConsolePreference.ts';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('I/O console preference defaults off and persists across reads', () => {
  const storage = createStorage();
  assert.equal(readMemoryViewerIoConsolePreference(storage), false);

  assert.equal(writeMemoryViewerIoConsolePreference(storage, true), true);
  assert.equal(storage.values.get(MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY), 'true');
  assert.equal(readMemoryViewerIoConsolePreference(storage), true);

  assert.equal(writeMemoryViewerIoConsolePreference(storage, false), true);
  assert.equal(storage.values.get(MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY), 'false');
  assert.equal(readMemoryViewerIoConsolePreference(storage), false);
});

test('I/O console preference accepts only exact stored boolean values', () => {
  const storage = createStorage();
  assert.equal(writeMemoryViewerIoConsolePreference(storage, 'true'), false);
  for (const invalid of ['1', 'TRUE', ' true', 'false ', 'yes', '']) {
    storage.values.set(MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY, invalid);
    assert.equal(readMemoryViewerIoConsolePreference(storage), false, invalid);
  }
  storage.values.set(MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY, 'false');
  assert.equal(readMemoryViewerIoConsolePreference(storage), false);
});

test('I/O console preference tolerates unavailable storage', () => {
  const getterThrows = () => { throw new Error('storage unavailable'); };
  const methodThrows = {
    getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); },
  };

  assert.equal(readMemoryViewerIoConsolePreference(getterThrows), false);
  assert.equal(readMemoryViewerIoConsolePreference(methodThrows), false);
  assert.equal(writeMemoryViewerIoConsolePreference(getterThrows, true), false);
  assert.equal(writeMemoryViewerIoConsolePreference(methodThrows, true), false);
  assert.equal(readMemoryViewerIoConsolePreference(null), false);
  assert.equal(writeMemoryViewerIoConsolePreference(null, true), false);
});
