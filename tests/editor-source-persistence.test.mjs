import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEditorSourcePersister,
  notifyEditorSourceChange,
  readEditorSource,
} from '../src/editor/sourcePersistence.ts';

function createStorage() {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

test('editor source survives a new app session, including empty and Unicode text', () => {
  const storage = createStorage();
  const initialSource = 'int main(void) { return 0; }';
  assert.equal(readEditorSource(() => storage, initialSource), initialSource);

  const persist = createEditorSourcePersister(initialSource, () => storage);
  persist('');
  assert.equal(readEditorSource(() => storage, initialSource), '');

  const unicodeSource = '// café 🧪\nint main(void) { return 0; }';
  persist(unicodeSource);
  assert.equal(readEditorSource(() => storage, initialSource), unicodeSource);
});

test('editor source changes write only changed text and retain the latest edit', () => {
  const storage = createStorage();
  const initialSource = 'int main(void) { return 0; }';
  const persist = createEditorSourcePersister(initialSource, () => storage);
  let publishedSource = initialSource;
  const publish = (source) => {
    publishedSource = notifyEditorSourceChange(source, publishedSource, persist);
  };

  publish(initialSource); // Initial layout publication.
  publish(initialSource); // Cursor or selection changed without a source edit.
  publish('int main(void) { return 1; }');
  publish('int main(void) { return 1; }'); // Cursor or selection changed again.
  publish('int main(void) { return 2; }');

  assert.deepEqual(storage.writes.map(([, source]) => source), [
    'int main(void) { return 1; }',
    'int main(void) { return 2; }',
  ]);
  assert.equal(readEditorSource(() => storage, initialSource), publishedSource);
});

test('storage access errors fall back safely and never block source edits', () => {
  const fallback = 'int main(void) { return 0; }';
  assert.equal(readEditorSource(() => { throw new Error('storage blocked'); }, fallback), fallback);
  assert.equal(readEditorSource(() => ({
    getItem() { throw new Error('read denied'); },
    setItem() {},
  }), fallback), fallback);

  const persist = createEditorSourcePersister(fallback, () => ({
    getItem() { return null; },
    setItem() { throw new Error('quota exceeded'); },
  }));
  assert.doesNotThrow(() => persist('int main(void) { return 1; }'));
});
