import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_VIEWER_SCALAR_VALUE_MAX_CHARACTERS,
  truncateMemoryViewerScalarValue,
} from '../src/memory/scalarValue.ts';

test('scalar values through ten characters stay complete', () => {
  assert.equal(MEMORY_VIEWER_SCALAR_VALUE_MAX_CHARACTERS, 10);
  assert.equal(truncateMemoryViewerScalarValue('1234567890'), '1234567890');
  assert.equal(truncateMemoryViewerScalarValue('-12.5'), '-12.5');
});

test('long scalar values keep the first five and final two characters', () => {
  assert.equal(truncateMemoryViewerScalarValue('12345678901'), '12345...01');
  assert.equal(truncateMemoryViewerScalarValue('123456789012345'), '12345...45');
});

test('scalar value truncation counts Unicode code points', () => {
  assert.equal(truncateMemoryViewerScalarValue('12😀45678901'), '12😀45...01');
});
