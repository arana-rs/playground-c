import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRECTORY = join(TEST_DIRECTORY, 'fixtures');

// Shared fixture loader for every engine phase. Paths are relative to the
// selected phase directory, e.g. fixtureSourceFor('p2', 'arrays.c').
export function fixtureSourceFor(phase, relativePath) {
  return readFileSync(join(FIXTURE_DIRECTORY, phase, relativePath), 'utf8');
}

// Backward-compatible P4 shorthand; `directory` is relative to fixtures/p4.
export function fixtureSource(directory = '.', name) {
  return fixtureSourceFor('p4', join(directory, name));
}

// Native compiler oracles need a final newline. Keep the engine input untouched
// and preserve existing LF/CRLF endings in the temporary source copy.
export function writeNativeSource(path, source) {
  if (!source.endsWith('\n') && source.endsWith('\\')) {
    throw new Error('A native oracle source cannot end with a backslash at EOF.');
  }
  writeFileSync(path, source.endsWith('\n') ? source : `${source}\n`);
}

export function fixtureProject(directory, entry, fileNames = [entry], translationUnits) {
  const project = {
    entry,
    files: fileNames.map((name) => ({ name, source: fixtureSource(directory, name) })),
  };
  if (translationUnits !== undefined) project.translationUnits = translationUnits;
  return project;
}

export function prepareProject(prepare, project) {
  const result = prepare(project);
  assert.equal(result.kind, 'prepared', JSON.stringify(result));
  return result.program;
}

export function executeTerminated(execute, program, options, expectedMainReturn = 1) {
  const result = execute(program, options);
  assert.equal(result.kind, 'terminated', JSON.stringify(result));
  assert.equal(result.mainReturn, expectedMainReturn);
  return result;
}

export function decodeBytes(value) {
  assert.ok(value instanceof Uint8Array, 'I/O result should preserve bytes as Uint8Array');
  return new TextDecoder().decode(value);
}
