import { MAKEFILE_NAME } from './languageMode.ts';

export const WORKSPACE_STORAGE_KEY = 'c-playground-workspace';
export const WORKSPACE_SCHEMA_VERSION = 1;
export const LEGACY_EDITOR_SOURCE_STORAGE_KEY = 'c-playground-editor-source';

export interface WorkspaceFile {
  id: string;
  name: string;
  source: string;
}

export interface Workspace {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  files: WorkspaceFile[];
  activeFileId: string;
}

export type WorkspacePersistenceStatus = 'compatible' | 'unsupported-version';

export interface WorkspaceReadState {
  workspace: Workspace;
  persistenceStatus: WorkspacePersistenceStatus;
}

export type WorkspaceFileNameError = 'empty' | 'invalid' | 'duplicate';

interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

type WorkspaceStorageProvider = () => WorkspaceStorage | null | undefined;

export interface WorkspaceStorageChange {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: unknown;
}

export type WorkspaceWriteAdmission = (() => boolean) & {
  observeStorageValue(serialized: string | null): void;
};

export function notifyEditorSourceChange(
  source: string,
  previouslyPublishedSource: string,
  onSourceChange?: (source: string) => void,
): string {
  if (source !== previouslyPublishedSource) onSourceChange?.(source);
  return source;
}

export function createDefaultWorkspace(defaultSource: string): Workspace {
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    files: [{ id: 'main', name: 'main.c', source: defaultSource }],
    activeFileId: 'main',
  };
}

export function getActiveWorkspaceFile(workspace: Workspace): WorkspaceFile {
  return workspace.files.find(file => file.id === workspace.activeFileId) ?? workspace.files[0]!;
}

export function guardWorkspaceMutation(
  currentWorkspace: Workspace,
  nextWorkspace: Workspace,
  persistenceStatus: WorkspacePersistenceStatus,
): Workspace {
  return persistenceStatus === 'unsupported-version' ? currentWorkspace : nextWorkspace;
}

export function updateWorkspaceFileSource(workspace: Workspace, fileId: string, source: string): Workspace {
  const existing = workspace.files.find(file => file.id === fileId);
  if (!existing || existing.source === source) return workspace;

  return {
    ...workspace,
    files: workspace.files.map(file => file.id === fileId ? { ...file, source } : file),
  };
}

export function getNextWorkspaceFileName(workspace: Workspace, extension: '.c' | '.h' = '.c'): string {
  const existingNames = new Set(workspace.files.map(file => file.name));
  let index = 2;
  let name = `file${index}${extension}`;
  while (existingNames.has(name)) {
    index += 1;
    name = `file${index}${extension}`;
  }
  return name;
}

export function getWorkspaceFileNameError(
  name: string,
  files?: readonly Pick<WorkspaceFile, 'id' | 'name'>[],
  excludedFileId?: string,
): WorkspaceFileNameError | null {
  const normalizedName = name.trim();
  if (!normalizedName) return 'empty';
  if (/[\\/]/.test(normalizedName)
    || (normalizedName !== MAKEFILE_NAME && !normalizedName.endsWith('.c') && !normalizedName.endsWith('.h'))) {
    return 'invalid';
  }
  if (files?.some(file => file.id !== excludedFileId && file.name === normalizedName)) return 'duplicate';
  return null;
}

export function addWorkspaceFile(workspace: Workspace, file: WorkspaceFile): Workspace {
  if (!file.id
    || getWorkspaceFileNameError(file.name, workspace.files) !== null
    || workspace.files.some(existing => existing.id === file.id)) return workspace;
  return {
    ...workspace,
    files: [...workspace.files, { ...file, name: file.name.trim() }],
    activeFileId: file.id,
  };
}

export function selectWorkspaceFile(workspace: Workspace, fileId: string): Workspace {
  if (workspace.activeFileId === fileId || !workspace.files.some(file => file.id === fileId)) return workspace;
  return { ...workspace, activeFileId: fileId };
}

export function renameWorkspaceFile(workspace: Workspace, fileId: string, name: string): Workspace {
  const normalizedName = name.trim();
  const existing = workspace.files.find(file => file.id === fileId);
  if (!existing || existing.name === normalizedName
    || getWorkspaceFileNameError(normalizedName, workspace.files, fileId) !== null) return workspace;
  return {
    ...workspace,
    files: workspace.files.map(file => file.id === fileId ? { ...file, name: normalizedName } : file),
  };
}

export function deleteWorkspaceFile(workspace: Workspace, fileId: string): Workspace {
  if (workspace.files.length <= 1) return workspace;
  const deletedIndex = workspace.files.findIndex(file => file.id === fileId);
  if (deletedIndex < 0) return workspace;
  const files = workspace.files.filter(file => file.id !== fileId);
  const activeFileId = workspace.activeFileId === fileId
    ? files[Math.min(deletedIndex, files.length - 1)]!.id
    : workspace.activeFileId;
  return { ...workspace, files, activeFileId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeWorkspaceFileNamesUnique(files: readonly WorkspaceFile[]): WorkspaceFile[] {
  const names = new Set<string>();
  return files.map(file => {
    if (!names.has(file.name)) {
      names.add(file.name);
      return file;
    }

    const extension = file.name === MAKEFILE_NAME
      ? '.c'
      : file.name.endsWith('.h') ? '.h' : '.c';
    let index = 1;
    let name = `file-${index}${extension}`;
    while (names.has(name)) {
      index += 1;
      name = `file-${index}${extension}`;
    }
    names.add(name);
    return { ...file, name };
  });
}

export function parseWorkspace(serialized: string): Workspace | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }

  if (!isRecord(value)
    || value.version !== WORKSPACE_SCHEMA_VERSION
    || !Array.isArray(value.files)
    || value.files.length === 0
    || typeof value.activeFileId !== 'string') return null;

  const ids = new Set<string>();
  const parsedFiles: WorkspaceFile[] = [];
  for (const item of value.files) {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || item.id.length === 0
      || typeof item.name !== 'string'
      || item.name.trim().length === 0
      || typeof item.source !== 'string'
      || ids.has(item.id)) return null;
    ids.add(item.id);
    parsedFiles.push({ id: item.id, name: item.name, source: item.source });
  }

  if (!ids.has(value.activeFileId)) return null;
  const files = makeWorkspaceFileNamesUnique(parsedFiles);
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    files,
    activeFileId: value.activeFileId,
  };
}

function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify({ ...workspace, files: makeWorkspaceFileNamesUnique(workspace.files) });
}

function declaresUnsupportedVersion(serialized: string): boolean {
  try {
    const value: unknown = JSON.parse(serialized);
    return isRecord(value)
      && Number.isSafeInteger(value.version)
      && value.version !== WORKSPACE_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

export function getWorkspacePersistenceStatus(getStorage: WorkspaceStorageProvider): WorkspacePersistenceStatus {
  try {
    const storage = getStorage();
    if (!storage) return 'compatible';
    const storedWorkspace = storage.getItem(WORKSPACE_STORAGE_KEY);
    return storedWorkspace !== null && declaresUnsupportedVersion(storedWorkspace)
      ? 'unsupported-version'
      : 'compatible';
  } catch {
    return 'compatible';
  }
}

export function createWorkspaceWriteAdmission(
  getStorage: WorkspaceStorageProvider,
  onUnsupportedVersion?: () => void,
): WorkspaceWriteAdmission {
  let unsupportedVersionObserved = false;

  const latchUnsupportedVersion = () => {
    if (unsupportedVersionObserved) return;
    unsupportedVersionObserved = true;
    onUnsupportedVersion?.();
  };

  const admission = (() => {
    if (unsupportedVersionObserved) return false;
    if (getWorkspacePersistenceStatus(getStorage) !== 'unsupported-version') return true;

    // This tab may hold an older workspace snapshot, so keep it locked after detecting a future schema.
    latchUnsupportedVersion();
    return false;
  }) as WorkspaceWriteAdmission;

  admission.observeStorageValue = (serialized) => {
    if (serialized !== null && declaresUnsupportedVersion(serialized)) latchUnsupportedVersion();
  };

  return admission;
}

export function handleWorkspaceStorageChange(
  event: WorkspaceStorageChange,
  getStorage: WorkspaceStorageProvider,
  admission: WorkspaceWriteAdmission,
  checkCurrentStorage: () => boolean = admission,
): void {
  if (event.key !== WORKSPACE_STORAGE_KEY && event.key !== null) return;

  let storage: WorkspaceStorage | null | undefined;
  try {
    storage = getStorage();
  } catch {
    return;
  }
  if (!storage || event.storageArea !== storage) return;

  if (event.key === WORKSPACE_STORAGE_KEY) admission.observeStorageValue(event.newValue);
  checkCurrentStorage();
}

export function runAfterWorkspaceCommit(
  commitWorkspace: () => boolean,
  applyEditorChange: () => boolean,
): boolean {
  return commitWorkspace() && applyEditorChange();
}

function tryRemoveLegacySource(storage: WorkspaceStorage): void {
  try {
    storage.removeItem?.(LEGACY_EDITOR_SOURCE_STORAGE_KEY);
  } catch {
    // The workspace has already been saved, so a stale legacy copy is harmless.
  }
}

function tryPersistMigratedWorkspace(storage: WorkspaceStorage, workspace: Workspace): boolean {
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspace(workspace));
    tryRemoveLegacySource(storage);
    return true;
  } catch {
    // Leave the legacy value in place unless the new schema was saved successfully.
    return false;
  }
}

export function readWorkspaceState(getStorage: WorkspaceStorageProvider, defaultSource: string): WorkspaceReadState {
  const fallback = () => createDefaultWorkspace(defaultSource);
  let storage: WorkspaceStorage | null | undefined;
  try {
    storage = getStorage();
  } catch {
    return { workspace: fallback(), persistenceStatus: 'compatible' };
  }
  if (!storage) return { workspace: fallback(), persistenceStatus: 'compatible' };

  let storedWorkspace: string | null = null;
  try {
    storedWorkspace = storage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // A failed read of the new key should not prevent a legacy recovery attempt.
  }
  const persistenceStatus = storedWorkspace !== null && declaresUnsupportedVersion(storedWorkspace)
    ? 'unsupported-version'
    : 'compatible';
  if (storedWorkspace !== null) {
    const parsed = parseWorkspace(storedWorkspace);
    if (parsed) return { workspace: parsed, persistenceStatus };
  }

  let legacySource: string | null = null;
  try {
    legacySource = storage.getItem(LEGACY_EDITOR_SOURCE_STORAGE_KEY);
  } catch {
    return { workspace: fallback(), persistenceStatus };
  }
  if (legacySource === null) return { workspace: fallback(), persistenceStatus };

  const migrated = createDefaultWorkspace(legacySource);
  if (storedWorkspace === null || !declaresUnsupportedVersion(storedWorkspace)) {
    tryPersistMigratedWorkspace(storage, migrated);
  }
  return { workspace: migrated, persistenceStatus };
}

export function readWorkspace(getStorage: WorkspaceStorageProvider, defaultSource: string): Workspace {
  return readWorkspaceState(getStorage, defaultSource).workspace;
}

export function createWorkspacePersister(
  initialWorkspace: Workspace,
  getStorage: WorkspaceStorageProvider,
): (workspace: Workspace) => boolean {
  let lastPersistedWorkspace = serializeWorkspace(initialWorkspace);

  return (workspace) => {
    const serialized = serializeWorkspace(workspace);
    if (serialized === lastPersistedWorkspace) return true;
    try {
      const storage = getStorage();
      if (!storage) return false;
      const storedWorkspace = storage.getItem(WORKSPACE_STORAGE_KEY);
      if (storedWorkspace !== null && declaresUnsupportedVersion(storedWorkspace)) return false;
      storage.setItem(WORKSPACE_STORAGE_KEY, serialized);
      lastPersistedWorkspace = serialized;
      tryRemoveLegacySource(storage);
      return true;
    } catch {
      // Storage can be disabled or full; editing must remain available.
      return false;
    }
  };
}
