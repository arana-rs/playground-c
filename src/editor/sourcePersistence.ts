export const EDITOR_SOURCE_STORAGE_KEY = 'c-playground-editor-source';

interface EditorSourceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type EditorSourceStorageProvider = () => EditorSourceStorage | null | undefined;

export function notifyEditorSourceChange(
  source: string,
  previouslyPublishedSource: string,
  onSourceChange?: (source: string) => void,
): string {
  if (source !== previouslyPublishedSource) onSourceChange?.(source);
  return source;
}

export function readEditorSource(
  getStorage: EditorSourceStorageProvider,
  fallback: string,
): string {
  try {
    return getStorage()?.getItem(EDITOR_SOURCE_STORAGE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function createEditorSourcePersister(
  initialSource: string,
  getStorage: EditorSourceStorageProvider,
): (source: string) => void {
  let lastPersistedSource = initialSource;

  return (source) => {
    if (source === lastPersistedSource) return;
    try {
      const storage = getStorage();
      if (!storage) return;
      storage.setItem(EDITOR_SOURCE_STORAGE_KEY, source);
      lastPersistedSource = source;
    } catch {
      // Storage can be disabled or full; editing must remain available.
    }
  };
}
