export const SYNTAX_ANALYSIS_STORAGE_KEY = 'c-playground-syntax-analysis';

export type SyntaxAnalysisMode = 'off' | 'syntax';

type StorageSource<T> = T | (() => T) | null | undefined;

function resolveStorage<T>(storage: StorageSource<T>): T | null | undefined {
  return typeof storage === 'function' ? (storage as () => T)() : storage;
}

export function readSyntaxAnalysisMode(
  storage: StorageSource<Pick<Storage, 'getItem'>>,
): SyntaxAnalysisMode {
  try {
    return resolveStorage(storage)?.getItem(SYNTAX_ANALYSIS_STORAGE_KEY) === 'syntax' ? 'syntax' : 'off';
  } catch {
    return 'off';
  }
}

export function writeSyntaxAnalysisMode(
  storage: StorageSource<Pick<Storage, 'setItem'>>,
  mode: SyntaxAnalysisMode,
): boolean {
  if (mode !== 'off' && mode !== 'syntax') return false;
  try {
    const resolvedStorage = resolveStorage(storage);
    resolvedStorage?.setItem(SYNTAX_ANALYSIS_STORAGE_KEY, mode);
    return resolvedStorage !== null && resolvedStorage !== undefined;
  } catch {
    return false;
  }
}
