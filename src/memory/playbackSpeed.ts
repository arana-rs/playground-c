import { RUN_CONFIGURATION } from '../execution/configuration.ts';

export const MEMORY_VIEWER_PLAYBACK_SPEED_STORAGE_KEY = 'c-playground-memory-viewer-playback-speed';

export const MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS = [
  { intervalMs: 2_000, labelKey: 'memoryViewer.playbackSpeed.verySlow' },
  { intervalMs: 1_000, labelKey: 'memoryViewer.playbackSpeed.slow' },
  { intervalMs: 500, labelKey: 'memoryViewer.playbackSpeed.normal' },
  { intervalMs: 250, labelKey: 'memoryViewer.playbackSpeed.fast' },
  { intervalMs: 100, labelKey: 'memoryViewer.playbackSpeed.veryFast' },
] as const;

export type MemoryViewerPlaybackInterval = typeof MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS[number]['intervalMs'];

export function isMemoryViewerPlaybackInterval(value: unknown): value is MemoryViewerPlaybackInterval {
  return typeof value === 'number' && MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS.some(option => option.intervalMs === value);
}

const configuredDefault = RUN_CONFIGURATION.memoryViewer.playIntervalMs;
if (!isMemoryViewerPlaybackInterval(configuredDefault)) {
  throw new Error('RUN_CONFIGURATION.memoryViewer.playIntervalMs must match a recommended playback speed.');
}

export const DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS: MemoryViewerPlaybackInterval = configuredDefault;

type StorageSource<T> = T | (() => T) | null | undefined;

function resolveStorage<T>(storage: StorageSource<T>): T | null | undefined {
  return typeof storage === 'function' ? (storage as () => T)() : storage;
}

export function readMemoryViewerPlaybackInterval(
  storage: StorageSource<Pick<Storage, 'getItem'>>,
  fallback: MemoryViewerPlaybackInterval = DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS,
): MemoryViewerPlaybackInterval {
  try {
    const storedValue = resolveStorage(storage)?.getItem(MEMORY_VIEWER_PLAYBACK_SPEED_STORAGE_KEY);
    const option = MEMORY_VIEWER_PLAYBACK_SPEED_OPTIONS.find(candidate => String(candidate.intervalMs) === storedValue);
    return option?.intervalMs ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeMemoryViewerPlaybackInterval(
  storage: StorageSource<Pick<Storage, 'setItem'>>,
  intervalMs: number,
): boolean {
  if (!isMemoryViewerPlaybackInterval(intervalMs)) return false;
  try {
    const resolvedStorage = resolveStorage(storage);
    resolvedStorage?.setItem(MEMORY_VIEWER_PLAYBACK_SPEED_STORAGE_KEY, String(intervalMs));
    return resolvedStorage !== null && resolvedStorage !== undefined;
  } catch {
    return false;
  }
}
