import { RUN_CONFIGURATION } from './configuration.ts';
import type { RunConfiguration } from './configuration.ts';

export const EXECUTION_SETTINGS_STORAGE_KEY = 'c-playground-execution-settings';

export interface ExecutionSettings {
  readonly maxDepth: number;
  readonly maxInstructions: number;
}

type StorageSource<T> = T | (() => T) | null | undefined;

function resolveStorage<T>(storage: StorageSource<T>): T | null | undefined {
  return typeof storage === 'function' ? (storage as () => T)() : storage;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requiredDefault(value: number | null | undefined, name: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`RUN_CONFIGURATION.options does not define a positive ${name} default.`);
  }
  return value;
}

/** User-adjustable budgets start from the same values as the shared run configuration. */
export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = Object.freeze({
  maxDepth: requiredDefault(
    RUN_CONFIGURATION.options.prepare?.limits?.maxDepth ?? RUN_CONFIGURATION.options.execute?.limits?.maxDepth,
    'maxDepth',
  ),
  maxInstructions: requiredDefault(RUN_CONFIGURATION.options.execute?.limits?.maxInstructions, 'maxInstructions'),
});

export function readExecutionSettings(
  storage: StorageSource<Pick<Storage, 'getItem'>>,
  fallback: ExecutionSettings = DEFAULT_EXECUTION_SETTINGS,
): ExecutionSettings {
  try {
    const storedValue = resolveStorage(storage)?.getItem(EXECUTION_SETTINGS_STORAGE_KEY);
    if (!storedValue) return fallback;
    const parsed: unknown = JSON.parse(storedValue);
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    const candidate = parsed as Record<string, unknown>;
    return {
      maxDepth: isPositiveSafeInteger(candidate.maxDepth) ? candidate.maxDepth : fallback.maxDepth,
      maxInstructions: isPositiveSafeInteger(candidate.maxInstructions) ? candidate.maxInstructions : fallback.maxInstructions,
    };
  } catch {
    return fallback;
  }
}

export function writeExecutionSettings(
  storage: StorageSource<Pick<Storage, 'setItem'>>,
  settings: ExecutionSettings,
): boolean {
  if (!isPositiveSafeInteger(settings.maxDepth) || !isPositiveSafeInteger(settings.maxInstructions)) return false;
  try {
    const resolvedStorage = resolveStorage(storage);
    resolvedStorage?.setItem(EXECUTION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return resolvedStorage !== null && resolvedStorage !== undefined;
  } catch {
    return false;
  }
}

/** Apply the two visible limits while preserving all shared Run budgets and services. */
export function createRunConfiguration(settings: ExecutionSettings): RunConfiguration {
  if (!isPositiveSafeInteger(settings.maxDepth) || !isPositiveSafeInteger(settings.maxInstructions)) {
    throw new RangeError('Execution settings must be positive safe integers.');
  }

  const prepare = RUN_CONFIGURATION.options.prepare ?? {};
  const execute = RUN_CONFIGURATION.options.execute ?? {};
  return {
    ...RUN_CONFIGURATION,
    options: {
      ...RUN_CONFIGURATION.options,
      prepare: {
        ...prepare,
        limits: { ...prepare.limits, maxDepth: settings.maxDepth },
      },
      execute: {
        ...execute,
        limits: {
          ...execute.limits,
          maxDepth: settings.maxDepth,
          maxInstructions: settings.maxInstructions,
        },
      },
    },
  };
}
