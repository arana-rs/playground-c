import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSyntaxRequest } from '../src/editor/syntaxAnalysisWorker.ts';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';
import {
  cloneWorkspaceSourceSnapshot,
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
} from '../src/execution/documentSnapshot.ts';
import { RunnerController } from '../src/execution/runnerController.ts';

function workspaceSnapshot(source, files = []) {
  return createWorkspaceSourceSnapshot(
    createExecutionDocumentSnapshot('main', 'main.c', 0, source),
    [{ id: 'main', name: 'main.c', source }, ...files],
  );
}

async function runWorkspace(snapshot) {
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  let worker;
  let request;
  const scope = {
    onmessage: null,
    postMessage: response => worker?.onmessage?.({ data: response }),
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });

  try {
    await import('../src/execution/engine.worker.ts?workspace-includes-regression');
    worker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(message) {
        request = message;
        scope.onmessage({ data: message });
      },
      terminate() {},
    };
    const controller = new RunnerController(RUN_CONFIGURATION, () => worker);
    controller.run(snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = controller.state;
    controller.dispose();
    return { request, state };
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
}

test('workspace snapshots freeze copied source files and isolate later input mutations', () => {
  const files = [
    { id: 'main', name: 'main.c', source: 'int main(void) { return 0; }' },
    { id: 'header', name: 'helper.h', source: 'int helper(void);' },
  ];
  const document = createExecutionDocumentSnapshot('main', 'main.c', 3, files[0].source);
  const snapshot = createWorkspaceSourceSnapshot(document, files);
  files[1].name = 'changed.h';
  files[1].source = 'int changed(void);';
  const clone = cloneWorkspaceSourceSnapshot(snapshot);

  assert.equal(snapshot.files[1].name, 'helper.h');
  assert.equal(snapshot.files[1].source, 'int helper(void);');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.files), true);
  assert.equal(Object.isFrozen(snapshot.files[1]), true);
  assert.notEqual(clone.files, snapshot.files);
  assert.notEqual(clone.files[1], snapshot.files[1]);
  assert.equal(clone.files[1].source, 'int helper(void);');
});

test('Run executes main.c with its header and included helper.c while ignoring sibling C files and virtual I/O', async () => {
  const main = `#include <stdio.h>
#include "helper.h"
#include "helper.c"

int main(void) {
  FILE *source = fopen("helper.c", "r");
  printf("%s:%s\\n", source == NULL ? "hidden" : "visible", helper_message());
  if (source != NULL) fclose(source);
  return source == NULL ? 0 : 1;
}
`;
  const snapshot = workspaceSnapshot(main, [
    { id: 'header', name: 'helper.h', source: 'const char *helper_message(void);\n' },
    {
      id: 'helper',
      name: 'helper.c',
      source: 'const char *helper_message(void) { return "from helper.c"; }\n',
    },
    { id: 'unused', name: 'unused.c', source: 'int main(void) { return 9; }\n' },
  ]);

  const { request, state } = await runWorkspace(snapshot);

  assert.equal(state.status, 'finished');
  assert.equal(state.result.kind, 'terminated');
  assert.equal(state.result.exitCode, 0);
  assert.equal(new TextDecoder().decode(state.result.stdout), 'hidden:from helper.c\n');
  assert.deepEqual(request.snapshot.files.map(file => file.name), ['main.c', 'helper.h', 'helper.c', 'unused.c']);
  assert.equal(request.snapshot.entry, 'main.c');
  assert.deepEqual(request.snapshot.translationUnits, ['main.c']);
  assert.equal(request.options.execute.io, undefined);
});

test('syntax analysis reports an included header syntax error at its original filename and line', () => {
  const snapshot = workspaceSnapshot('#include "broken.h"\nint main(void) { return 0; }\n', [
    {
      id: 'header',
      name: 'broken.h',
      source: 'typedef struct { int value; } Broken;\nint malformed( {\n',
    },
  ]);

  const response = analyzeSyntaxRequest({ type: 'analyze', jobId: 1, snapshot, options: {} });

  assert.equal(response.type, 'result');
  assert.equal(response.result.kind, 'error');
  const diagnostic = response.result.diagnostics.find(item => item.file === 'broken.h');
  assert.ok(diagnostic);
  assert.equal(diagnostic.line, 2);
});

test('syntax analysis reports a missing local include at the including source location', () => {
  const snapshot = workspaceSnapshot('#include "missing.h"\nint main(void) { return 0; }\n');

  const response = analyzeSyntaxRequest({ type: 'analyze', jobId: 2, snapshot, options: {} });

  assert.equal(response.type, 'result');
  assert.equal(response.result.kind, 'error');
  const diagnostic = response.result.diagnostics.find(item => item.code === 'INCLUDE_NOT_FOUND');
  assert.ok(diagnostic);
  assert.equal(diagnostic.file, 'main.c');
  assert.equal(diagnostic.line, 1);
});
