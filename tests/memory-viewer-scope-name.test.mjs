import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS, truncateMemoryViewerScopeName } from '../src/memory/scopeName.ts';

test('scope names up to 20 characters remain complete', () => {
  assert.equal(MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS, 20);
  assert.equal(truncateMemoryViewerScopeName('while (x < 10)'), 'while (x < 10)');
  assert.equal(truncateMemoryViewerScopeName('12345678901234567890'), '12345678901234567890');
});

test('long scope names keep the first 15 and final 2 characters with three dots', () => {
  assert.equal(truncateMemoryViewerScopeName('123456789012345678901'), '123456789012345...01');
  const doScopeName = 'do { ... } while (...)';
  assert.equal(Array.from(doScopeName).length, 22);
  assert.equal(truncateMemoryViewerScopeName(doScopeName), 'do { ... } whil....)');
});

test('scope name truncation counts Unicode code points without splitting a surrogate pair', () => {
  const scopeName = `${'a'.repeat(14)}😀${'b'.repeat(6)}`;
  assert.equal(truncateMemoryViewerScopeName(scopeName), `${'a'.repeat(14)}😀...bb`);
});
