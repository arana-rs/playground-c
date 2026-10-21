import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSyntaxRequest } from '../src/editor/syntaxAnalysisWorker.ts';
import {
  cloneWorkspaceSourceSnapshot,
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
  sameWorkspaceSourceSnapshot,
} from '../src/execution/documentSnapshot.ts';
import { resolveBuildPlan } from '../src/build/buildPlan.ts';
import { RUN_CONFIGURATION } from '../src/execution/configuration.ts';
import { MemoryViewerController } from '../src/memory/MemoryViewerController.ts';

const makefileSource = `SOURCES = helper.c main.c
program: $(SOURCES)
	cc $(SOURCES) -o $@
`;

const helperHeader = 'int helper(void);\n';
const helperSource = 'int helper(void) {\n  return 41;\n}\n';
const mainSource = `#include <stdio.h>
#include "helper.h"

int main(void) {
  FILE *source = fopen("helper.c", "r");
  printf("%d:%s\\n", helper(), source == NULL ? "hidden" : "visible");
  if (source != NULL) fclose(source);
  return 0;
}
`;

function createWorkspaceSnapshot(activeName, files) {
  const activeFile = files.find(file => file.name === activeName);
  assert.ok(activeFile, `workspace contains ${activeName}`);
  return createWorkspaceSourceSnapshot(
    createExecutionDocumentSnapshot(activeFile.id, activeFile.name, 7, activeFile.source),
    files,
  );
}

function makeWorkspace(files = []) {
  return [
    { id: 'build', name: 'Makefile', source: makefileSource },
    { id: 'header', name: 'helper.h', source: helperHeader },
    { id: 'helper', name: 'helper.c', source: helperSource },
    { id: 'main', name: 'main.c', source: mainSource },
    { id: 'broken', name: 'broken.c', source: 'int broken( {\n' },
    ...files,
  ];
}

async function runInWorker(snapshot, suffix) {
  const responses = [];
  const scope = { onmessage: null, postMessage: response => responses.push(response) };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });
  try {
    await import(`../src/execution/engine.worker.ts?makefile-run-${suffix}`);
    scope.onmessage({ data: {
      type: 'run',
      jobId: 1,
      snapshot,
      options: { prepare: {}, execute: {} },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));
    return responses;
  } finally {
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  }
}

class InlineMemoryWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  messages = [];

  constructor(scope) {
    this.scope = scope;
  }

  postMessage(data) {
    this.messages.push(data);
    this.scope.onmessage?.({ data });
  }

  terminate() {}

  emit(data) {
    this.onmessage?.({ data });
  }
}

function startMemoryViewer(snapshot, suffix) {
  const responses = [];
  let worker;
  const scope = {
    onmessage: null,
    postMessage(response) {
      responses.push(response);
      worker?.emit(response);
    },
  };
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: scope });
  const promise = import(`../src/memory/memory.worker.ts?makefile-debug-${suffix}`);
  return promise.then(() => {
    const controller = new MemoryViewerController(snapshot, {
      workerFactory: () => {
        worker = new InlineMemoryWorker(scope);
        return worker;
      },
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
    });
    return {
      controller,
      responses,
      cleanup() {
        controller.dispose();
        if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
        else delete globalThis.self;
      },
    };
  });
}

test('one Makefile plan drives Run and analysis from Makefile and header tabs', async () => {
  const files = makeWorkspace();
  const makefileSnapshot = createWorkspaceSnapshot('Makefile', files);
  const plan = resolveBuildPlan(makefileSnapshot.files, makefileSnapshot.fileName);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.plan, {
    target: 'program',
    entry: 'helper.c',
    translationUnits: ['helper.c', 'main.c'],
  });

  for (const [index, activeName] of ['Makefile', 'helper.h'].entries()) {
    const snapshot = createWorkspaceSnapshot(activeName, files);
    const responses = await runInWorker(snapshot, `valid-${index}`);
    const result = responses.find(response => response.type === 'result')?.result;
    assert.equal(result?.kind, 'terminated');
    assert.equal(new TextDecoder().decode(result.stdout), '41:hidden\n');
    assert.equal(result.exitCode, 0);

    const analysis = analyzeSyntaxRequest({ type: 'analyze', jobId: index + 1, snapshot, options: {} });
    assert.equal(analysis.type, 'result');
    assert.equal(analysis.result.kind, 'ok');
    assert.equal(snapshot.files.some(file => file.id === 'broken' && file.name === 'broken.c'), true);
    assert.equal(snapshot.translationUnits.length, 1, 'origin metadata remains separate from the resolved plan');
  }
});

test('an invalid Makefile reports its own location and never falls back to a valid active C file', async () => {
  const files = makeWorkspace();
  files[0].source = 'SOURCES = main.c\nprogram: $(SOURCES)\n\tcc $(SOURCES) -pthread -o $@\n';
  const snapshot = createWorkspaceSnapshot('main.c', files);
  const resolution = resolveBuildPlan(snapshot.files, snapshot.fileName);
  assert.equal(resolution.status, 'invalid');
  assert.ok(resolution.diagnostics.length > 0);
  assert.equal(resolution.diagnostics[0].file, 'Makefile');
  assert.ok(resolution.diagnostics[0].line > 0);
  assert.ok(resolution.diagnostics[0].column > 0);

  const runResponses = await runInWorker(snapshot, 'invalid');
  const runResult = runResponses.find(response => response.type === 'result')?.result;
  assert.equal(runResult?.kind, 'prepare-error');
  assert.deepEqual(runResult?.diagnostics, resolution.diagnostics);

  const analysis = analyzeSyntaxRequest({ type: 'analyze', jobId: 9, snapshot, options: {} });
  assert.equal(analysis.type, 'result');
  assert.equal(analysis.result.kind, 'error');
  assert.deepEqual(analysis.result.diagnostics, resolution.diagnostics);

  const debug = await startMemoryViewer(snapshot, 'invalid');
  try {
    debug.controller.start();
    assert.equal(debug.responses.some(response => response.type === 'debug-ready'), false);
    const error = debug.responses.find(response => response.type === 'debug-error');
    assert.ok(error);
    assert.match(error.message, /^Makefile:\d+:\d+:/u);
    assert.equal(debug.controller.state.status, 'error');
  } finally {
    debug.cleanup();
  }
});

test('debugging preserves origin metadata while resolving entry and historical source labels', async () => {
  const snapshot = createWorkspaceSnapshot('Makefile', makeWorkspace());
  const debug = await startMemoryViewer(snapshot, 'valid');
  try {
    assert.equal(debug.controller.state.document.fileName, 'Makefile');
    assert.equal(debug.controller.state.sourceFileName, 'helper.c');
    assert.equal(debug.controller.state.source, helperSource);

    debug.controller.start();
    assert.equal(debug.responses[0].type, 'debug-ready');
    assert.deepEqual(debug.controller.state.document, {
      documentId: 'build',
      fileName: 'Makefile',
      sourceRevision: 7,
      source: makefileSource,
    });
    assert.equal(debug.controller.state.location?.file, 'main.c');
    assert.equal(debug.controller.state.sourceFileName, 'main.c');

    for (let step = 0; step < 30 && debug.controller.state.location?.file !== 'helper.c'; step += 1) {
      debug.controller.next();
    }
    assert.equal(debug.controller.state.location?.file, 'helper.c');
    assert.equal(debug.controller.state.sourceFileName, 'helper.c');
    assert.equal(debug.controller.state.source, helperSource);

    debug.controller.previous();
    assert.equal(debug.controller.state.location?.file, 'main.c');
    assert.equal(debug.controller.state.source, mainSource);
    debug.controller.next();
    assert.equal(debug.controller.state.location?.file, 'helper.c');
    assert.equal(debug.controller.state.source, helperSource);
  } finally {
    debug.cleanup();
  }
});

test('captured Makefile and sibling changes produce new plans without changing an earlier run', async () => {
  const originalFiles = makeWorkspace([
    { id: 'other', name: 'other.c', source: 'int helper(void) { return 72; }\n' },
  ]);
  const captured = createWorkspaceSnapshot('main.c', originalFiles);
  const capturedClone = cloneWorkspaceSourceSnapshot(captured);

  originalFiles[2].source = 'int helper(void) { return 99; }\n';
  const changedSibling = createWorkspaceSnapshot('main.c', originalFiles);
  assert.equal(sameWorkspaceSourceSnapshot(captured, changedSibling), false);
  assert.deepEqual(
    resolveBuildPlan(captured.files, captured.fileName).plan?.translationUnits,
    resolveBuildPlan(changedSibling.files, changedSibling.fileName).plan?.translationUnits,
  );

  originalFiles[0].source = 'SOURCES = other.c main.c\nprogram: $(SOURCES)\n\tcc $(SOURCES) -o $@\n';
  originalFiles[2].name = 'renamed-helper.c';
  originalFiles[5].source = 'int helper(void) { return 73; }\n';
  const updated = createWorkspaceSnapshot('main.c', originalFiles);
  assert.equal(sameWorkspaceSourceSnapshot(changedSibling, updated), false);
  assert.notDeepEqual(
    resolveBuildPlan(captured.files, captured.fileName).plan?.translationUnits,
    resolveBuildPlan(updated.files, updated.fileName).plan?.translationUnits,
  );
  assert.deepEqual(capturedClone.files.map(file => file.name), captured.files.map(file => file.name));

  const oldRun = await runInWorker(capturedClone, 'captured-old');
  const siblingRun = await runInWorker(changedSibling, 'captured-sibling');
  const newRun = await runInWorker(updated, 'captured-new');
  const oldResult = oldRun.find(response => response.type === 'result')?.result;
  const siblingResult = siblingRun.find(response => response.type === 'result')?.result;
  const newResult = newRun.find(response => response.type === 'result')?.result;
  assert.equal(oldResult?.kind, 'terminated');
  assert.equal(siblingResult?.kind, 'terminated');
  assert.equal(newResult?.kind, 'terminated');
  assert.equal(new TextDecoder().decode(oldResult.stdout), '41:hidden\n');
  assert.equal(new TextDecoder().decode(siblingResult.stdout), '99:hidden\n');
  assert.equal(new TextDecoder().decode(newResult.stdout), '73:hidden\n');
  assert.equal(oldResult.metrics.readMs >= 0, true);
  assert.equal(RUN_CONFIGURATION.options.execute?.io, undefined, 'workspace sources stay separate from runtime io.files');
});
