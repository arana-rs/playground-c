import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, prepare } from '@playground/c11-engine/core';
import { createWorkerRuntimeServices } from '../src/execution/workerRuntimeServices.ts';

test('the Worker service factory injects its host clock separately from serializable execution options', () => {
  const source = `#include <time.h>
int main(void) {
  struct timespec now;
  if (time(0) != 1704067200L) return 1;
  if (timespec_get(&now, TIME_UTC) != TIME_UTC) return 2;
  return now.tv_sec == 1704067200L && now.tv_nsec == 123000000L ? 0 : 3;
}`;
  const preparation = prepare({ entry: 'worker-clock.c', files: [{ name: 'worker-clock.c', source }] });
  assert.equal(preparation.kind, 'prepared', JSON.stringify(preparation));

  let clockReads = 0;
  const runtimeServices = createWorkerRuntimeServices(() => {
    clockReads += 1;
    return 1_704_067_200_123;
  });
  const result = execute(preparation.program, {}, runtimeServices);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, 0);
  assert.equal(clockReads, 2);
});
