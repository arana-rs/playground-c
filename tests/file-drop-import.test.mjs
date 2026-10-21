import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSyntax, execute, prepare } from '@playground/c11-engine/core';
import {
  MAX_IMPORTED_SOURCE_BYTES,
  addPreparedDroppedSource,
  isFileTransfer,
  prepareDroppedSource,
  preflightDroppedFiles,
} from '../src/editor/fileDropImport.ts';
import {
  createDefaultWorkspace,
  createWorkspacePersister,
} from '../src/editor/sourcePersistence.ts';
import {
  EditorSessionStore,
  updateEditorSessionSnapshot,
} from '../src/editor/editorSessions.ts';

function droppedFile(name, content, options = {}) {
  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  let reads = 0;
  return {
    name,
    size: options.size ?? bytes.byteLength,
    get reads() { return reads; },
    arrayBuffer() {
      reads++;
      if (options.readError) return Promise.reject(options.readError);
      return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    },
  };
}

function deferredDroppedFile(name, content) {
  const bytes = new TextEncoder().encode(content);
  let resolveRead;
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer() {
      return new Promise(resolve => {
        resolveRead = () => resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      });
    },
    finishRead() { resolveRead(); },
  };
}

function makeAdded(workspace, prepared, id) {
  const result = addPreparedDroppedSource(workspace, prepared, id);
  assert.equal(result.status, 'accepted');
  return result.value;
}

test('preflight accepts exactly 1 MiB and rejects larger files before reading', async () => {
  const workspace = createDefaultWorkspace('starter');
  const limitFile = droppedFile('limit.c', 'x'.repeat(MAX_IMPORTED_SOURCE_BYTES));
  const tooLargeFile = droppedFile('large.c', 'x', { size: MAX_IMPORTED_SOURCE_BYTES + 1 });

  assert.equal(preflightDroppedFiles([limitFile], workspace).status, 'accepted');
  assert.equal((await prepareDroppedSource([limitFile], workspace)).status, 'accepted');
  assert.deepEqual(preflightDroppedFiles([tooLargeFile], workspace), {
    status: 'rejected',
    reason: 'file-too-large',
    fileName: 'large.c',
  });
  assert.equal(tooLargeFile.reads, 0);
});

test('only a file transfer is eligible for import UI, while text drags stay ordinary editor input', () => {
  assert.equal(isFileTransfer({ types: ['text/plain'], items: [{ kind: 'string' }] }), false);
  assert.equal(isFileTransfer({ types: ['Files'], items: [{ kind: 'file' }] }), true);
  assert.equal(isFileTransfer({ types: [], items: [{ kind: 'file' }] }), true);
});

test('preflight rejects multi-file, duplicate, changed, and non-lowercase .c names atomically', () => {
  const workspace = createDefaultWorkspace('starter');
  const first = droppedFile('first.c', 'first');
  const second = droppedFile('second.c', 'second');

  assert.equal(preflightDroppedFiles([first, second], workspace).reason, 'multiple-files');
  assert.equal(first.reads + second.reads, 0);
  assert.equal(preflightDroppedFiles([droppedFile('main.c', 'x')], workspace).reason, 'duplicate-name');
  assert.equal(preflightDroppedFiles([droppedFile(' main.c', 'x')], workspace).reason, 'invalid-name');
  assert.equal(preflightDroppedFiles([droppedFile('Main.C', 'x')], workspace).reason, 'unsupported-extension');
  assert.equal(preflightDroppedFiles([droppedFile('folder/source.c', 'x')], workspace).reason, 'invalid-name');
});

test('UTF-8 decoding is strict, NUL text is rejected, read failures are reported, and empty files are valid', async () => {
  const workspace = createDefaultWorkspace('starter');
  const invalidUtf8 = droppedFile('invalid.c', new Uint8Array([0xc3, 0x28]));
  const nulText = droppedFile('binary.c', 'int\0main;');
  const unreadable = droppedFile('unreadable.c', '', { readError: new Error('blocked') });
  const empty = droppedFile('empty.c', '');

  assert.equal((await prepareDroppedSource([invalidUtf8], workspace)).reason, 'invalid-utf8');
  assert.equal((await prepareDroppedSource([nulText], workspace)).reason, 'contains-nul');
  assert.equal((await prepareDroppedSource([unreadable], workspace)).reason, 'read-failed');
  assert.deepEqual(await prepareDroppedSource([empty], workspace), {
    status: 'accepted',
    value: { name: 'empty.c', source: '' },
  });
});

test('UTF-8 BOM is removed while importing source, preserving interior U+FEFF and running it', async () => {
  const workspace = createDefaultWorkspace('starter');
  const dropped = droppedFile(
    'bom.c',
    '\uFEFF/* interior U+FEFF: \uFEFF */\r\n#include <stdio.h>\r\nint main(void) {\r\n    puts("imported");\r\n    return 0;\r\n}\r\n',
  );
  const imported = await prepareDroppedSource([dropped], workspace);

  assert.equal(imported.status, 'accepted', JSON.stringify(imported));
  assert.deepEqual(imported.value, {
    name: 'bom.c',
    source: '/* interior U+FEFF: \uFEFF */\n#include <stdio.h>\nint main(void) {\n    puts("imported");\n    return 0;\n}\n',
  });

  const project = {
    entry: imported.value.name,
    files: [{ name: imported.value.name, source: imported.value.source }],
  };
  const analysis = analyzeSyntax(project);
  assert.equal(analysis.kind, 'ok', JSON.stringify(analysis));

  const preparation = prepare(project);
  assert.equal(preparation.kind, 'prepared', JSON.stringify(preparation));

  const result = execute(preparation.program);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(new TextDecoder().decode(result.stdout), 'imported\n');
});

test('line validation normalizes CRLF and preserves the editor trailing newline limit', async () => {
  const workspace = createDefaultWorkspace('starter');
  const exactly999Lines = `${'line\r\n'.repeat(998)}line`;
  const exactly999WithTrailingLineFeed = 'line\r\n'.repeat(998);
  const line1000WithTrailingLineFeed = 'line\r\n'.repeat(999);

  assert.deepEqual(await prepareDroppedSource([droppedFile('lines.c', exactly999Lines)], workspace), {
    status: 'accepted',
    value: { name: 'lines.c', source: `${'line\n'.repeat(998)}line` },
  });
  assert.deepEqual(await prepareDroppedSource([droppedFile('trailing.c', exactly999WithTrailingLineFeed)], workspace), {
    status: 'accepted',
    value: { name: 'trailing.c', source: 'line\n'.repeat(998) },
  });
  assert.deepEqual(await prepareDroppedSource([droppedFile('too-many.c', line1000WithTrailingLineFeed)], workspace), {
    status: 'rejected',
    reason: 'too-many-lines',
    fileName: 'too-many.c',
    lineCount: 1000,
  });
});

test('a concurrently prepared same-name file is rejected against the current workspace at commit', async () => {
  const initial = createDefaultWorkspace('starter');
  const first = deferredDroppedFile('shared.c', 'int first;');
  const second = deferredDroppedFile('shared.c', 'int second;');
  const firstRead = prepareDroppedSource([first], initial);
  const secondRead = prepareDroppedSource([second], initial);

  first.finishRead();
  second.finishRead();
  const [firstPrepared, secondPrepared] = await Promise.all([firstRead, secondRead]);
  assert.equal(firstPrepared.status, 'accepted');
  assert.equal(secondPrepared.status, 'accepted');

  const committed = makeAdded(initial, firstPrepared.value, 'import-first');
  const racedCommit = addPreparedDroppedSource(committed.workspace, secondPrepared.value, 'import-second');
  assert.equal(racedCommit.status, 'rejected');
  assert.equal(racedCommit.reason, 'duplicate-name');
  assert.equal(racedCommit.value, undefined);
  assert.deepEqual(committed.workspace.files.map(file => [file.id, file.name, file.source]), [
    ['main', 'main.c', 'starter'],
    ['import-first', 'shared.c', 'int first;'],
  ]);
});

test('import adds and activates one new ID while existing edit history, selection, and viewport survive queued IME activation', async () => {
  const initial = createDefaultWorkspace('source A');
  const prepared = await prepareDroppedSource([droppedFile('imported.c', 'int imported;\n')], initial);
  assert.equal(prepared.status, 'accepted');
  const added = makeAdded(initial, prepared.value, 'imported-id');
  const store = new EditorSessionStore('main', 'source A', {
    text: 'source A',
    selection: { start: 0, end: 0, direction: 'none' },
    pairs: [],
  });
  const original = store.active;
  const edited = {
    ...original.snapshot,
    text: 'edited A',
    selection: { start: 2, end: 6, direction: 'backward' },
  };
  original.history.record(original.snapshot, edited);
  updateEditorSessionSnapshot(original, edited);
  original.viewport = { scrollTop: 83, scrollLeft: 17 };
  store.beginComposition();

  assert.equal(store.requestActivation(added.file.id, added.file.source), null);
  assert.equal(store.activeId, 'main');
  assert.equal(added.workspace.activeFileId, 'imported-id');
  const imported = store.finishComposition();

  assert.equal(imported.documentId, 'imported-id');
  assert.equal(imported.snapshot.text, 'int imported;\n');
  assert.equal(store.get('main'), original);
  assert.equal(original.snapshot.text, 'edited A');
  assert.deepEqual(original.snapshot.selection, { start: 2, end: 6, direction: 'backward' });
  assert.deepEqual(original.viewport, { scrollTop: 83, scrollLeft: 17 });
  assert.equal(original.history.undo(original.snapshot).text, 'source A');
});

test('a storage failure reports unsaved while the imported workspace remains available in memory', async () => {
  const initial = createDefaultWorkspace('starter');
  const prepared = await prepareDroppedSource([droppedFile('offline.c', 'int offline;')], initial);
  assert.equal(prepared.status, 'accepted');
  const added = makeAdded(initial, prepared.value, 'offline-id');
  const persist = createWorkspacePersister(initial, () => ({
    getItem() { return null; },
    setItem() { throw new Error('quota exceeded'); },
  }));
  let inMemoryWorkspace = added.workspace;

  assert.equal(persist(inMemoryWorkspace), false);
  assert.equal(inMemoryWorkspace.activeFileId, 'offline-id');
  assert.deepEqual(inMemoryWorkspace.files.at(-1), {
    id: 'offline-id',
    name: 'offline.c',
    source: 'int offline;',
  });
});
