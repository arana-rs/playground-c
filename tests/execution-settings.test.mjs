import assert from 'node:assert/strict';
import test from 'node:test';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';
import {
  DEFAULT_EXECUTION_SETTINGS,
  EXECUTION_SETTINGS_STORAGE_KEY,
  createRunConfiguration,
  isPositiveSafeInteger,
  readExecutionSettings,
  writeExecutionSettings,
} from '../src/execution/settings.ts';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    values,
  };
}

test('execution settings inherit shared defaults and override only depth and instruction budgets', () => {
  assert.deepEqual(DEFAULT_EXECUTION_SETTINGS, {
    maxDepth: RUN_CONFIGURATION.options.prepare.limits.maxDepth,
    maxInstructions: RUN_CONFIGURATION.options.execute.limits.maxInstructions,
  });

  const configuration = createRunConfiguration({ maxDepth: 256, maxInstructions: 337_300 });
  assert.equal(configuration.options.prepare.limits.maxDepth, 256);
  assert.equal(configuration.options.execute.limits.maxDepth, 256);
  assert.equal(configuration.options.execute.limits.maxInstructions, 337_300);
  assert.equal(configuration.options.prepare.limits.maxTokens, RUN_CONFIGURATION.options.prepare.limits.maxTokens);
  assert.equal(configuration.options.execute.limits.maxMemoryBytes, RUN_CONFIGURATION.options.execute.limits.maxMemoryBytes);
  assert.equal(configuration.timeoutMs, RUN_CONFIGURATION.timeoutMs);
  assert.equal(RUN_CONFIGURATION.options.prepare.limits.maxDepth, DEFAULT_EXECUTION_SETTINGS.maxDepth);
  assert.equal(RUN_CONFIGURATION.options.execute.limits.maxInstructions, DEFAULT_EXECUTION_SETTINGS.maxInstructions);
});

test('settings persist as one validated preference and malformed fields fall back independently', () => {
  const storage = createStorage();
  const chosen = { maxDepth: 512, maxInstructions: 337_300 };
  assert.equal(writeExecutionSettings(storage, chosen), true);
  assert.equal(storage.values.get(EXECUTION_SETTINGS_STORAGE_KEY), JSON.stringify(chosen));
  assert.deepEqual(readExecutionSettings(storage), chosen);

  storage.setItem(EXECUTION_SETTINGS_STORAGE_KEY, JSON.stringify({ maxDepth: 0, maxInstructions: 2 ** 53 }));
  assert.deepEqual(readExecutionSettings(storage), DEFAULT_EXECUTION_SETTINGS);
  storage.setItem(EXECUTION_SETTINGS_STORAGE_KEY, JSON.stringify({ maxDepth: 12, maxInstructions: '5000' }));
  assert.deepEqual(readExecutionSettings(storage), {
    maxDepth: 12,
    maxInstructions: DEFAULT_EXECUTION_SETTINGS.maxInstructions,
  });
});

test('settings reject non-positive, fractional, unsafe, non-finite, and non-numeric values', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
    assert.equal(isPositiveSafeInteger(value), false);
  }
  assert.equal(isPositiveSafeInteger(1), true);
  assert.equal(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER), true);
  assert.equal(writeExecutionSettings(createStorage(), { maxDepth: 1, maxInstructions: Number.NaN }), false);
  assert.throws(() => createRunConfiguration({ maxDepth: 0, maxInstructions: 1 }), RangeError);
});

test('unavailable storage getters and methods fall back without breaking the app', () => {
  const getterThrows = () => { throw new Error('storage unavailable'); };
  const methodThrows = {
    getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); },
  };
  assert.deepEqual(readExecutionSettings(getterThrows), DEFAULT_EXECUTION_SETTINGS);
  assert.deepEqual(readExecutionSettings(methodThrows), DEFAULT_EXECUTION_SETTINGS);
  assert.equal(writeExecutionSettings(getterThrows, DEFAULT_EXECUTION_SETTINGS), false);
  assert.equal(writeExecutionSettings(methodThrows, DEFAULT_EXECUTION_SETTINGS), false);
});
