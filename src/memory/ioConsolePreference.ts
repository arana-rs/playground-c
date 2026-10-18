export const MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY = 'c-playground-memory-viewer-io-console';

type StorageSource<T> = T | (() => T) | null | undefined;

function resolveStorage<T>(storage: StorageSource<T>): T | null | undefined {
  return typeof storage === 'function' ? (storage as () => T)() : storage;
}

export function readMemoryViewerIoConsolePreference(
  storage: StorageSource<Pick<Storage, 'getItem'>>,
): boolean {
  try {
    const storedValue = resolveStorage(storage)?.getItem(MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY);
    if (storedValue === 'true') return true;
    if (storedValue === 'false') return false;
    return false;
  } catch {
    return false;
  }
}

export function writeMemoryViewerIoConsolePreference(
  storage: StorageSource<Pick<Storage, 'setItem'>>,
  enabled: boolean,
): boolean {
  if (typeof enabled !== 'boolean') return false;
  try {
    const resolvedStorage = resolveStorage(storage);
    resolvedStorage?.setItem(MEMORY_VIEWER_IO_CONSOLE_STORAGE_KEY, String(enabled));
    return resolvedStorage !== null && resolvedStorage !== undefined;
  } catch {
    return false;
  }
}
