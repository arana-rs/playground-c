import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_EDITOR_SOURCE_STORAGE_KEY,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_KEY,
  addWorkspaceFile,
  createWorkspaceWriteAdmission,
  createDefaultWorkspace,
  createWorkspacePersister,
  handleWorkspaceStorageChange,
  deleteWorkspaceFile,
  getActiveWorkspaceFile,
  getNextWorkspaceFileName,
  getWorkspaceFileNameError,
  guardWorkspaceMutation,
  notifyEditorSourceChange,
  parseWorkspace,
  readWorkspace,
  readWorkspaceState,
  renameWorkspaceFile,
  runAfterWorkspaceCommit,
  selectWorkspaceFile,
  updateWorkspaceFileSource,
} from '../src/editor/sourcePersistence.ts';
import { isEditorMutationBlocked } from '../src/editor/editorEditing.ts';

function createStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  const writes = [];
  const removes = [];
  return {
    values,
    writes,
    removes,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
    removeItem(key) {
      removes.push(key);
      values.delete(key);
    },
  };
}

test('default workspace uses the supplied example as its sole initial source', () => {
  const example = 'int main(void) { return 0; }';
  const workspace = createDefaultWorkspace(example);

  assert.deepEqual(workspace, {
    version: WORKSPACE_SCHEMA_VERSION,
    files: [{ id: 'main', name: 'main.c', source: example }],
    activeFileId: 'main',
  });
  assert.equal(getActiveWorkspaceFile(workspace).source, example);
});

test('legacy string migrates to main.c, including empty and Unicode source', () => {
  for (const legacySource of ['', '// café 🧪\nint main(void) { return 0; }']) {
    const storage = createStorage({ [LEGACY_EDITOR_SOURCE_STORAGE_KEY]: legacySource });
    const workspace = readWorkspace(() => storage, 'default example');

    assert.equal(workspace.activeFileId, 'main');
    assert.deepEqual(workspace.files, [{ id: 'main', name: 'main.c', source: legacySource }]);
    assert.deepEqual(JSON.parse(storage.values.get(WORKSPACE_STORAGE_KEY)), workspace);
    assert.equal(storage.values.has(LEGACY_EDITOR_SOURCE_STORAGE_KEY), false);
    assert.deepEqual(storage.removes, [LEGACY_EDITOR_SOURCE_STORAGE_KEY]);
  }
});

test('multiple documents round trip with their active ID and stable IDs after edits', () => {
  const workspace = {
    version: WORKSPACE_SCHEMA_VERSION,
    files: [
      { id: 'file-main', name: 'main.c', source: 'int main(void) { return 0; }' },
      { id: 'file-ユニコード', name: 'lib/π.c', source: '// 🧪' },
    ],
    activeFileId: 'file-ユニコード',
  };
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: JSON.stringify(workspace) });
  const restored = readWorkspace(() => storage, 'default');
  const edited = updateWorkspaceFileSource(restored, restored.activeFileId, '');
  const persist = createWorkspacePersister(restored, () => storage);
  persist(edited);
  const reloaded = readWorkspace(() => storage, 'default');

  assert.equal(getActiveWorkspaceFile(reloaded).id, 'file-ユニコード');
  assert.equal(getActiveWorkspaceFile(reloaded).source, '');
  assert.deepEqual(reloaded.files.map(file => file.id), ['file-main', 'file-ユニコード']);
  assert.deepEqual(JSON.parse(storage.values.get(WORKSPACE_STORAGE_KEY)), edited);
});

test('workspace file management adds, selects, renames, and deletes files without dropping data', () => {
  const initial = createDefaultWorkspace('main source');
  const first = addWorkspaceFile(initial, { id: 'file-a', name: ' file2.c ', source: 'first source' });
  const second = addWorkspaceFile(first, { id: 'file-b', name: 'file3.c', source: 'second source' });

  assert.equal(getNextWorkspaceFileName(initial), 'file2.c');
  assert.equal(getNextWorkspaceFileName(second), 'file4.c');
  assert.equal(second.activeFileId, 'file-b');
  assert.deepEqual(second.files.map(file => [file.id, file.name, file.source]), [
    ['main', 'main.c', 'main source'],
    ['file-a', 'file2.c', 'first source'],
    ['file-b', 'file3.c', 'second source'],
  ]);

  const selected = selectWorkspaceFile(second, 'file-a');
  const renamed = renameWorkspaceFile(selected, 'file-a', ' renamed.c ');
  assert.equal(renamed.activeFileId, 'file-a');
  assert.equal(renamed.files[1].name, 'renamed.c');
  assert.equal(renamed.files[1].source, 'first source');
  assert.equal(renameWorkspaceFile(renamed, 'file-a', '   '), renamed);
  assert.equal(selectWorkspaceFile(renamed, 'missing'), renamed);

  const deletedActive = deleteWorkspaceFile(renamed, 'file-a');
  assert.deepEqual(deletedActive.files.map(file => file.id), ['main', 'file-b']);
  assert.equal(deletedActive.activeFileId, 'file-b', 'the next file takes the deleted tab position');
  assert.equal(deletedActive.files[1].source, 'second source');

  const deletedInactive = deleteWorkspaceFile(second, 'file-a');
  assert.equal(deletedInactive.activeFileId, 'file-b');
  assert.deepEqual(deletedInactive.files.map(file => file.id), ['main', 'file-b']);
});

test('workspace file management rejects duplicate IDs and protects the final file', () => {
  const onlyFile = createDefaultWorkspace('main source');
  assert.equal(addWorkspaceFile(onlyFile, { id: 'main', name: 'other.c', source: 'other' }), onlyFile);
  assert.equal(deleteWorkspaceFile(onlyFile, 'main'), onlyFile);
  assert.equal(deleteWorkspaceFile(onlyFile, 'missing'), onlyFile);

  const twoFiles = addWorkspaceFile(onlyFile, { id: 'other', name: 'other.c', source: 'other' });
  const deletedLastActive = deleteWorkspaceFile(twoFiles, 'other');
  assert.deepEqual(deletedLastActive.files, onlyFile.files);
  assert.equal(deletedLastActive.activeFileId, 'main');
});

test('the starter file can be renamed and deleted when another file remains', () => {
  const initial = createDefaultWorkspace('starter');
  const withSecondFile = addWorkspaceFile(initial, { id: 'second', name: 'second.c', source: 'int main(void) { return 0; }' });
  const renamedStarter = renameWorkspaceFile(withSecondFile, 'main', 'starter.c');
  assert.equal(renamedStarter.files[0].name, 'starter.c');

  const selectedStarter = selectWorkspaceFile(renamedStarter, 'main');
  const deletedStarter = deleteWorkspaceFile(selectedStarter, 'main');
  assert.deepEqual(deletedStarter.files, [{ id: 'second', name: 'second.c', source: 'int main(void) { return 0; }' }]);
  assert.equal(deletedStarter.activeFileId, 'second');
});

test('flat C, header, and exact Makefile names are validated centrally', () => {
  const initial = createDefaultWorkspace('starter');
  assert.equal(getWorkspaceFileNameError('   '), 'empty');
  assert.equal(getWorkspaceFileNameError('folder/file.c'), 'invalid');
  assert.equal(getWorkspaceFileNameError('file.h'), null);
  assert.equal(getWorkspaceFileNameError('file.c'), null);
  assert.equal(getWorkspaceFileNameError('Makefile'), null);
  assert.equal(getWorkspaceFileNameError('makefile'), 'invalid');
  assert.equal(addWorkspaceFile(initial, { id: 'bad', name: 'folder/file.c', source: '' }), initial);

  const added = addWorkspaceFile(initial, { id: 'good', name: 'file.c', source: '' });
  const header = addWorkspaceFile(added, { id: 'header', name: 'types.h', source: 'struct Item;' });
  assert.equal(header.activeFileId, 'header');
  assert.equal(header.files[2].name, 'types.h');
  const duplicateName = addWorkspaceFile(added, { id: 'same-name', name: 'file.c', source: 'int main(void) { return 1; }' });
  assert.equal(duplicateName, added);
  assert.equal(getWorkspaceFileNameError('file.c', added.files), 'duplicate');
  assert.equal(renameWorkspaceFile(header, 'header', 'folder/renamed.c'), header);
  assert.equal(renameWorkspaceFile(header, 'header', 'renamed.h').files[2].source, 'struct Item;');
});

test('the default source can be renamed to exact Makefile and restored with its source and ID', () => {
  const initial = createDefaultWorkspace('all:\n\t@echo ready\n');
  const storage = createStorage();
  const persist = createWorkspacePersister(initial, () => storage);
  const withNewFile = addWorkspaceFile(initial, {
    id: 'file-2',
    name: getNextWorkspaceFileName(initial),
    source: 'int main(void) { return 0; }',
  });
  const renamed = renameWorkspaceFile(withNewFile, 'main', 'Makefile');
  const selectedMakefile = selectWorkspaceFile(renamed, 'main');
  persist(selectedMakefile);

  const reloaded = readWorkspace(() => storage, 'unused default');
  assert.equal(reloaded.activeFileId, 'main');
  assert.deepEqual(reloaded.files, [
    { id: 'main', name: 'Makefile', source: 'all:\n\t@echo ready\n' },
    { id: 'file-2', name: 'file2.c', source: 'int main(void) { return 0; }' },
  ]);
});

test('Makefile duplicate names are blocked by add and rename and normalized on restoration', () => {
  const initial = createDefaultWorkspace('default C source');
  const makefile = renameWorkspaceFile(initial, 'main', 'Makefile');
  const withSource = addWorkspaceFile(makefile, { id: 'source', name: 'file2.c', source: 'int main(void) {}' });
  assert.equal(getWorkspaceFileNameError('Makefile', withSource.files), 'duplicate');
  assert.equal(addWorkspaceFile(withSource, { id: 'second-makefile', name: 'Makefile', source: 'second' }), withSource);
  assert.equal(renameWorkspaceFile(withSource, 'source', 'Makefile'), withSource);

  const duplicated = {
    version: WORKSPACE_SCHEMA_VERSION,
    files: [
      { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' },
      { id: 'makefile-a', name: 'Makefile', source: 'all:\n\t@echo first' },
      { id: 'fallback-name', name: 'file-1.c', source: 'int fallback;' },
      { id: 'makefile-b', name: 'Makefile', source: 'all:\n\t@echo second' },
    ],
    activeFileId: 'makefile-b',
  };
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: JSON.stringify(duplicated) });
  const restored = readWorkspace(() => storage, 'unused default');
  assert.deepEqual(restored?.files, [
    { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' },
    { id: 'makefile-a', name: 'Makefile', source: 'all:\n\t@echo first' },
    { id: 'fallback-name', name: 'file-1.c', source: 'int fallback;' },
    { id: 'makefile-b', name: 'file-2.c', source: 'all:\n\t@echo second' },
  ]);
  assert.equal(restored?.activeFileId, 'makefile-b');
});

test('new file names start at file2 and skip existing names', () => {
  const initial = createDefaultWorkspace('starter');
  const withFile2 = addWorkspaceFile(initial, { id: 'file-2', name: 'file2.c', source: '' });
  const withFile3 = addWorkspaceFile(withFile2, { id: 'file-3', name: 'file3.c', source: '' });

  assert.equal(getNextWorkspaceFileName(initial), 'file2.c');
  assert.equal(getNextWorkspaceFileName(withFile2), 'file3.c');
  assert.equal(getNextWorkspaceFileName(withFile3), 'file4.c');
  assert.equal(getNextWorkspaceFileName(initial, '.h'), 'file2.h');
});

test('restoring duplicate saved C and header names keeps every file and source', () => {
  const workspace = {
    version: WORKSPACE_SCHEMA_VERSION,
    files: [
      { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' },
      { id: 'header-a', name: 'shared.h', source: 'struct First;' },
      { id: 'header-b', name: 'shared.h', source: 'struct Second;' },
      { id: 'source-a', name: 'helper.c', source: 'int first(void) { return 1; }' },
      { id: 'source-b', name: 'helper.c', source: 'int second(void) { return 2; }' },
    ],
    activeFileId: 'header-b',
  };
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: JSON.stringify(workspace) });
  const restored = readWorkspace(() => storage, 'unused default');

  assert.equal(restored.activeFileId, 'header-b');
  assert.deepEqual(restored.files, [
    { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' },
    { id: 'header-a', name: 'shared.h', source: 'struct First;' },
    { id: 'header-b', name: 'file-1.h', source: 'struct Second;' },
    { id: 'source-a', name: 'helper.c', source: 'int first(void) { return 1; }' },
    { id: 'source-b', name: 'file-1.c', source: 'int second(void) { return 2; }' },
  ]);
});

test('CRUD operations persist and restore the selected source file with its final contents', () => {
  const initial = createDefaultWorkspace('int main(void) { return 0; }');
  const storage = createStorage();
  const persist = createWorkspacePersister(initial, () => storage);
  let workspace = initial;

  workspace = addWorkspaceFile(workspace, {
    id: 'first',
    name: getNextWorkspaceFileName(workspace),
    source: 'int main(void) { return 1; }',
  });
  persist(workspace);
  workspace = addWorkspaceFile(workspace, {
    id: 'temporary',
    name: getNextWorkspaceFileName(workspace),
    source: 'int main(void) { return 2; }',
  });
  persist(workspace);
  workspace = renameWorkspaceFile(workspace, 'temporary', 'temporary.c');
  persist(workspace);
  workspace = updateWorkspaceFileSource(workspace, 'temporary', 'int main(void) { return 22; }');
  persist(workspace);
  workspace = selectWorkspaceFile(workspace, 'first');
  persist(workspace);
  workspace = deleteWorkspaceFile(workspace, 'temporary');
  persist(workspace);

  const restored = readWorkspace(() => storage, 'unused default');
  assert.equal(restored.activeFileId, 'first');
  assert.deepEqual(restored.files, [
    { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' },
    { id: 'first', name: 'file2.c', source: 'int main(void) { return 1; }' },
  ]);
});

test('workspace validation rejects malformed, duplicate, orphaned, and unsupported data', () => {
  const valid = {
    version: WORKSPACE_SCHEMA_VERSION,
    files: [{ id: 'main', name: 'main.c', source: '' }],
    activeFileId: 'main',
  };
  assert.deepEqual(parseWorkspace(JSON.stringify(valid)), valid);
  assert.equal(parseWorkspace('{'), null);
  assert.equal(parseWorkspace(JSON.stringify({ ...valid, version: 2 })), null);
  assert.equal(parseWorkspace(JSON.stringify({ ...valid, files: [] })), null);
  assert.equal(parseWorkspace(JSON.stringify({ ...valid, activeFileId: 'missing' })), null);
  assert.equal(parseWorkspace(JSON.stringify({
    ...valid,
    files: [...valid.files, { id: 'main', name: 'other.c', source: 'x' }],
  })), null);
  assert.equal(parseWorkspace(JSON.stringify({
    ...valid,
    files: [{ id: 'main', name: 'main.c', source: null }],
  })), null);
});

test('workspace restoration accepts more than 64 files and long IDs and names', () => {
  const longId = `file-${'i'.repeat(160)}`;
  const longName = `src/${'long-name-'.repeat(32)}.c`;
  const files = Array.from({ length: 65 }, (_, index) => ({
    id: index === 64 ? longId : `file-${index}`,
    name: index === 64 ? longName : `file-${index}.c`,
    source: `int value_${index};`,
  }));
  const workspace = { version: WORKSPACE_SCHEMA_VERSION, files, activeFileId: longId };
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: JSON.stringify(workspace) });
  const restored = readWorkspace(() => storage, 'default');

  assert.equal(restored.files.length, 65);
  assert.equal(getActiveWorkspaceFile(restored).id, longId);
  assert.equal(getActiveWorkspaceFile(restored).name, longName);
});

test('corrupt workspace data falls back to legacy without deleting it on failed migration', () => {
  const legacySource = '// preserved legacy';
  const corrupted = JSON.stringify({ version: WORKSPACE_SCHEMA_VERSION, files: [], activeFileId: 'x' });
  const storage = {
    values: new Map([
      [WORKSPACE_STORAGE_KEY, corrupted],
      [LEGACY_EDITOR_SOURCE_STORAGE_KEY, legacySource],
    ]),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem() { throw new Error('quota exceeded'); },
    removeItem(key) { this.values.delete(key); },
  };

  const workspace = readWorkspace(() => storage, 'default example');
  assert.deepEqual(workspace.files, [{ id: 'main', name: 'main.c', source: legacySource }]);
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), corrupted);
  assert.equal(storage.values.get(LEGACY_EDITOR_SOURCE_STORAGE_KEY), legacySource);
});

test('unknown workspace versions remain intact through fallback and later edits', () => {
  const futureWorkspace = JSON.stringify({ version: 2, files: [{ id: 'future', name: 'future.c', source: 'int future;' }], activeFileId: 'future' });
  const legacySource = 'int main(void) { return 7; }';
  const storage = createStorage({
    [WORKSPACE_STORAGE_KEY]: futureWorkspace,
    [LEGACY_EDITOR_SOURCE_STORAGE_KEY]: legacySource,
  });
  const restored = readWorkspace(() => storage, 'default');
  const edited = updateWorkspaceFileSource(restored, restored.activeFileId, 'int main(void) { return 8; }');
  createWorkspacePersister(restored, () => storage)(edited);

  assert.deepEqual(restored.files, [{ id: 'main', name: 'main.c', source: legacySource }]);
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), futureWorkspace);
  assert.equal(storage.values.get(LEGACY_EDITOR_SOURCE_STORAGE_KEY), legacySource);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.removes, []);
});

test('unsupported workspace versions lock every workspace mutation and preserve the exact stored bytes', () => {
  const futureWorkspace = '{\n  "version": 2,\n  "files": [{"id":"future","name":"future.c","source":"int future;"}],\n  "activeFileId": "future"\n}\n';
  const storage = createStorage({
    [WORKSPACE_STORAGE_KEY]: futureWorkspace,
    [LEGACY_EDITOR_SOURCE_STORAGE_KEY]: 'int main(void) { return 7; }',
  });
  const state = readWorkspaceState(() => storage, 'default');
  const currentWorkspace = state.workspace;
  const workspaceWithFile = addWorkspaceFile(currentWorkspace, {
    id: 'extra', name: 'extra.c', source: 'int extra;',
  });
  const mutations = [
    {
      current: currentWorkspace,
      next: updateWorkspaceFileSource(currentWorkspace, currentWorkspace.activeFileId, 'changed'),
    },
    { current: currentWorkspace, next: workspaceWithFile },
    { current: workspaceWithFile, next: selectWorkspaceFile(workspaceWithFile, currentWorkspace.activeFileId) },
    {
      current: currentWorkspace,
      next: renameWorkspaceFile(currentWorkspace, currentWorkspace.activeFileId, 'renamed.c'),
    },
    { current: workspaceWithFile, next: deleteWorkspaceFile(workspaceWithFile, 'extra') },
  ];

  assert.equal(state.persistenceStatus, 'unsupported-version');
  for (const { current, next } of mutations) {
    assert.strictEqual(guardWorkspaceMutation(current, next, state.persistenceStatus), current);
  }

  for (const { current, next } of mutations) {
    assert.equal(createWorkspacePersister(current, () => storage)(next), false);
  }
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), futureWorkspace);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.removes, []);
});

test('compatible workspaces remain writable through the same mutation guard', () => {
  const storage = createStorage();
  const state = readWorkspaceState(() => storage, 'initial source');
  const edited = updateWorkspaceFileSource(state.workspace, state.workspace.activeFileId, 'edited source');
  const guarded = guardWorkspaceMutation(state.workspace, edited, state.persistenceStatus);

  assert.equal(state.persistenceStatus, 'compatible');
  assert.strictEqual(guarded, edited);
  assert.equal(createWorkspacePersister(state.workspace, () => storage)(guarded), true);
  assert.deepEqual(JSON.parse(storage.values.get(WORKSPACE_STORAGE_KEY)), edited);
});

test('the first editor mutation checks a cross-tab schema change before React rerenders', () => {
  const storage = createStorage();
  let lockNotices = 0;
  const canMutateWorkspace = createWorkspaceWriteAdmission(() => storage, () => lockNotices += 1);
  let source = 'saved source';

  const mutate = () => {
    if (isEditorMutationBlocked(false, canMutateWorkspace)) return false;
    source += ' changed';
    return true;
  };

  assert.equal(mutate(), true);
  assert.equal(source, 'saved source changed');
  source = 'saved source';
  const futureWorkspace = '{\n  "version": 2, "files": [], "activeFileId": "future"\n}\n';
  storage.values.set(WORKSPACE_STORAGE_KEY, futureWorkspace);

  assert.equal(mutate(), false);
  assert.equal(source, 'saved source');
  assert.equal(lockNotices, 1);
  assert.equal(isEditorMutationBlocked(false, canMutateWorkspace), true);
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), futureWorkspace);
  assert.deepEqual(storage.writes, []);
});

test('storage events latch a future payload even when current storage is compatible', () => {
  const compatibleWorkspace = createDefaultWorkspace('saved source');
  const compatibleValue = JSON.stringify(compatibleWorkspace);
  const futureValue = '{\n  "version": 2, "files": [], "activeFileId": "future"\n}\n';
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: compatibleValue });
  let lockNotices = 0;
  const admission = createWorkspaceWriteAdmission(() => storage, () => lockNotices += 1);

  handleWorkspaceStorageChange(
    { key: WORKSPACE_STORAGE_KEY, newValue: compatibleValue, storageArea: storage },
    () => storage,
    admission,
  );
  assert.equal(admission(), true, 'a compatible storage event keeps mutations enabled');

  handleWorkspaceStorageChange(
    { key: 'unrelated-key', newValue: futureValue, storageArea: storage },
    () => storage,
    admission,
  );
  handleWorkspaceStorageChange(
    { key: WORKSPACE_STORAGE_KEY, newValue: futureValue, storageArea: {} },
    () => storage,
    admission,
  );
  assert.equal(admission(), true, 'unrelated keys and storage areas are ignored');

  handleWorkspaceStorageChange(
    { key: WORKSPACE_STORAGE_KEY, newValue: futureValue, storageArea: storage },
    () => storage,
    admission,
  );

  assert.equal(admission(), false);
  assert.equal(isEditorMutationBlocked(false, admission), true);
  assert.equal(lockNotices, 1);
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), compatibleValue);
  assert.deepEqual(storage.writes, []);
});

test('debug example replacement waits for workspace commit and compatible workspaces still apply it', () => {
  const futureWorkspace = '{\n  "version": 2, "files": [], "activeFileId": "future"\n}\n';
  const storage = createStorage();
  const state = readWorkspaceState(() => storage, 'saved source');
  const persist = createWorkspacePersister(state.workspace, () => storage);
  const canMutateWorkspace = createWorkspaceWriteAdmission(() => storage);
  let source = getActiveWorkspaceFile(state.workspace).source;
  storage.values.set(WORKSPACE_STORAGE_KEY, futureWorkspace);

  const rejected = runAfterWorkspaceCommit(
    () => canMutateWorkspace() && persist(selectWorkspaceFile(state.workspace, state.workspace.activeFileId)),
    () => {
      source = 'debug example';
      return true;
    },
  );

  assert.equal(rejected, false);
  assert.equal(source, 'saved source');
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), futureWorkspace);
  assert.deepEqual(storage.writes, []);

  const compatibleStorage = createStorage();
  const compatibleState = readWorkspaceState(() => compatibleStorage, 'saved source');
  const compatiblePersist = createWorkspacePersister(compatibleState.workspace, () => compatibleStorage);
  const compatibleAdmission = createWorkspaceWriteAdmission(() => compatibleStorage);
  let compatibleSource = getActiveWorkspaceFile(compatibleState.workspace).source;
  const applied = runAfterWorkspaceCommit(
    () => compatibleAdmission(),
    () => {
      compatibleSource = 'debug example';
      const nextWorkspace = updateWorkspaceFileSource(compatibleState.workspace, 'main', compatibleSource);
      return compatiblePersist(nextWorkspace);
    },
  );

  assert.equal(applied, true);
  assert.equal(compatibleSource, 'debug example');
  assert.equal(JSON.parse(compatibleStorage.values.get(WORKSPACE_STORAGE_KEY)).files[0].source, 'debug example');
});

test('invalid saved data without a legacy value leaves storage untouched and uses the default', () => {
  const corrupted = '{not json';
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: corrupted });
  const workspace = readWorkspace(() => storage, 'default example');

  assert.deepEqual(workspace, createDefaultWorkspace('default example'));
  assert.equal(storage.values.get(WORKSPACE_STORAGE_KEY), corrupted);
  assert.deepEqual(storage.writes, []);
});

test('editor source publication suppresses unchanged source and publishes edits', () => {
  const published = [];
  let lastSource = 'default';
  lastSource = notifyEditorSourceChange('default', lastSource, source => published.push(source));
  lastSource = notifyEditorSourceChange('default', lastSource, source => published.push(source));
  lastSource = notifyEditorSourceChange('edited', lastSource, source => published.push(source));

  assert.deepEqual(published, ['edited']);
  assert.equal(lastSource, 'edited');
});

test('storage access errors fall back safely and never block source edits', () => {
  const fallback = createDefaultWorkspace('default example');
  assert.deepEqual(readWorkspace(() => { throw new Error('storage blocked'); }, 'default example'), fallback);
  assert.deepEqual(readWorkspace(() => ({
    getItem() { throw new Error('read denied'); },
    setItem() {},
  }), 'default example'), fallback);

  const persist = createWorkspacePersister(fallback, () => ({
    getItem() { return null; },
    setItem() { throw new Error('quota exceeded'); },
  }));
  const edited = updateWorkspaceFileSource(fallback, 'main', 'int main(void) { return 1; }');
  assert.equal(persist(edited), false, 'the caller can report that the memory-only edit was not saved');
});

test('workspace persister writes changed snapshots and clears legacy only after a successful save', () => {
  const initial = createDefaultWorkspace('initial');
  const edited = updateWorkspaceFileSource(initial, 'main', 'edited');
  const storage = createStorage({ [LEGACY_EDITOR_SOURCE_STORAGE_KEY]: 'legacy' });
  const persist = createWorkspacePersister(initial, () => storage);

  assert.equal(persist(initial), true);
  assert.equal(persist(edited), true);
  assert.equal(persist(edited), true);

  assert.equal(storage.writes.length, 1);
  assert.deepEqual(JSON.parse(storage.values.get(WORKSPACE_STORAGE_KEY)), edited);
  assert.deepEqual(storage.removes, [LEGACY_EDITOR_SOURCE_STORAGE_KEY]);
});
