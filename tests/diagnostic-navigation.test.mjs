import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEditorSourceLocationOffset,
  isEditorSourceLocationNavigable,
  projectEditorDiagnostics,
  resolveEditorSourceLocation,
} from '../src/editor/editorDiagnostics.ts';
import {
  EditorSessionStore,
  replaceEditorSessionText,
  updateEditorSessionSnapshot,
} from '../src/editor/editorSessions.ts';
import {
  addWorkspaceFile,
  createDefaultWorkspace,
  deleteWorkspaceFile,
  renameWorkspaceFile,
  selectWorkspaceFile,
} from '../src/editor/sourcePersistence.ts';
import {
  formatConsoleSegments,
  formatResultSummary,
} from '../src/execution/consoleOutput.ts';
import { RUN_CONFIGURATION, RunnerController } from '../src/execution/useRunner.ts';
import {
  createExecutionDocumentSnapshot,
  createWorkspaceSourceSnapshot,
  matchesCurrentDocument,
} from '../src/execution/documentSnapshot.ts';

const editorSnapshot = text => ({
  text,
  selection: { start: 0, end: 0, direction: 'none' },
  pairs: [],
});

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  messages = [];

  postMessage(message) { this.messages.push(message); }
  terminate() {}
  emit(data) { this.onmessage?.({ data }); }
}

function createCapturedRun() {
  const mainSource = '#include "header.h"\nint main(void) { return 0; }\n';
  const headerSource = 'int header_value;\n';
  const makefileSource = '#line 90 "generated.mk"\nall:\n\tcc main.c\n';
  const document = createExecutionDocumentSnapshot('main-id', 'main.c', 4, mainSource);
  const sourceSnapshot = createWorkspaceSourceSnapshot(document, [
    { id: 'main-id', name: 'main.c', source: mainSource },
    { id: 'header-original-id', name: 'header.h', source: headerSource },
    { id: 'makefile-id', name: 'Makefile', source: makefileSource },
  ]);
  const result = {
    kind: 'prepare-error',
    diagnostics: [
      { code: 'PREPROCESSOR_ERROR', message: 'Main source diagnostic.', file: 'main.c', line: 1, column: 1 },
      { code: 'PREPROCESSOR_ERROR', message: 'Header diagnostic.', file: 'header.h', line: 1, column: 5 },
      { code: 'MAKEFILE_ERROR', message: 'Makefile diagnostic.', file: 'Makefile', line: 2, column: 1 },
    ],
    metrics: {},
  };
  const summary = formatResultSummary(result, sourceSnapshot);
  return { mainSource, headerSource, makefileSource, sourceSnapshot, result, summary };
}

test('maps one-based source coordinates through tabs and CRLF, with explicit clamping to current text', () => {
  const capturedSource = '\tfirst\r\n\tsecond';

  assert.equal(getEditorSourceLocationOffset(capturedSource, 1, 2), 1);
  assert.equal(getEditorSourceLocationOffset(capturedSource, 2, 2), 9);
  assert.equal(getEditorSourceLocationOffset(capturedSource, 1, 99), null);
  assert.equal(getEditorSourceLocationOffset(capturedSource, 99, 1), null);
  assert.equal(getEditorSourceLocationOffset(capturedSource, 1, 99, true), 6);
  assert.equal(getEditorSourceLocationOffset(capturedSource, 99, 99, true), capturedSource.length);

  const currentSource = '\tshort\r\n\tx';
  assert.equal(getEditorSourceLocationOffset(currentSource, 2, 99), null);
  assert.equal(getEditorSourceLocationOffset(currentSource, 2, 99, true), currentSource.length);
  assert.equal(isEditorSourceLocationNavigable(currentSource, 'main.c', 2, 2), true);

  const unicodeSource = '\tα😀x\r\n\tfinal';
  assert.equal(getEditorSourceLocationOffset(unicodeSource, 1, 4), 3, 'diagnostic columns count UTF-16 code units');
  assert.equal(getEditorSourceLocationOffset(unicodeSource, 2, 2), 8, 'CRLF and tabs each follow editor offsets');
});

test('result locations carry captured source IDs and do not mark matching stdout text', () => {
  const { sourceSnapshot, result, summary } = createCapturedRun();
  const locations = summary.diagnosticLocations;

  assert.deepEqual(locations.map(({ file, line, column, sourceId }) => ({ file, line, column, sourceId })), [
    { file: 'main.c', line: 1, column: 1, sourceId: 'main-id' },
    { file: 'header.h', line: 1, column: 5, sourceId: 'header-original-id' },
    { file: 'Makefile', line: 2, column: 1, sourceId: 'makefile-id' },
  ]);
  assert.deepEqual(locations.map(({ start, end }) => summary.text.slice(start, end)), [
    'main.c:1:1',
    'header.h:1:5',
    'Makefile:2:1',
  ]);
  assert.ok(locations.every(({ start, end }) => start >= 0 && start <= end && end <= summary.text.length));
  assert.equal(isEditorSourceLocationNavigable(
    sourceSnapshot.files.find(file => file.name === 'Makefile').source,
    'Makefile',
    2,
    1,
  ), true, 'Makefile coordinates remain physical even when its text contains #line');

  const worker = new FakeWorker();
  const runner = new RunnerController(RUN_CONFIGURATION, () => worker);
  runner.run(sourceSnapshot);
  const jobId = worker.messages[0].jobId;
  worker.emit({
    type: 'output',
    jobId,
    sequence: 1,
    stream: 'stdout',
    chunk: new TextEncoder().encode('header.h:1:5'),
  });
  worker.emit({ type: 'result', jobId, result: {
    ...result,
    metrics: {
      readMs: 0,
      prepareMs: 0,
      executeMs: 0,
      totalMs: 0,
      sourceChars: 0,
      tokenCount: 0,
      preprocessSteps: 0,
      instructionCount: 0,
      peakMemoryBytes: 0,
    },
  } });
  const segments = formatConsoleSegments(runner.state);
  runner.dispose();

  assert.equal(segments[0].text, 'header.h:1:5');
  assert.equal(segments[0].diagnosticLocations, undefined);
  assert.ok(segments[1].text.startsWith('\n'));
  const headerLocation = segments[1].diagnosticLocations.find(location => location.file === 'header.h');
  assert.ok(headerLocation);
  assert.equal(segments[1].text.slice(headerLocation.start, headerLocation.end), 'header.h:1:5');
  assert.equal(headerLocation.sourceId, 'header-original-id');
  assert.ok(segments[1].diagnosticLocations.every(({ start, end }) => start >= 0 && start <= end && end <= segments[1].text.length));
});

test('analysis related notes preserve their text and source location for session activation', () => {
  const { mainSource, headerSource, sourceSnapshot } = createCapturedRun();
  const diagnostic = {
    code: 'PARSE_ERROR',
    message: 'Expected an expression.',
    file: 'main.c',
    line: 2,
    column: 5,
    endLine: 2,
    endColumn: 9,
    related: [{
      message: 'Header declaration is here.',
      file: 'header.h',
      line: 1,
      column: 5,
    }],
  };
  const [projected] = projectEditorDiagnostics(mainSource, [diagnostic], 'main.c', sourceSnapshot.files);
  const related = projected.relatedLocations[0];

  assert.deepEqual({
    message: related.message,
    file: related.file,
    line: related.line,
    column: related.column,
    sourceId: related.sourceId,
    anchors: related.anchors,
  }, {
    message: 'Header declaration is here.',
    file: 'header.h',
    line: 1,
    column: 5,
    sourceId: 'header-original-id',
    anchors: [],
  });

  const store = new EditorSessionStore('main-id', mainSource, editorSnapshot(mainSource));
  const activated = store.requestActivation(related.sourceId, headerSource);
  assert.equal(activated?.documentId, 'header-original-id');
  assert.equal(getEditorSourceLocationOffset(activated.snapshot.text, related.line, related.column), 4);
});

test('captured targets follow a renamed file ID, preserve edits, and do not select a same-name replacement', () => {
  const { mainSource, headerSource, summary } = createCapturedRun();
  const headerLocation = summary.diagnosticLocations.find(location => location.file === 'header.h');
  assert.ok(headerLocation);

  const workspace = addWorkspaceFile(createDefaultWorkspace(mainSource), {
    id: headerLocation.sourceId,
    name: 'header.h',
    source: headerSource,
  });
  const renamedWorkspace = renameWorkspaceFile(workspace, headerLocation.sourceId, 'renamed.h');
  assert.equal(renamedWorkspace.files.find(file => file.id === headerLocation.sourceId)?.name, 'renamed.h');
  assert.equal(selectWorkspaceFile(renamedWorkspace, headerLocation.sourceId).activeFileId, headerLocation.sourceId);

  const store = new EditorSessionStore('main', mainSource, editorSnapshot(mainSource));
  const headerSession = store.requestActivation(headerLocation.sourceId, headerSource);
  assert.ok(headerSession);
  assert.equal(replaceEditorSessionText(headerSession, 'int locally_edited_header;\n')?.status, 'applied');
  store.requestActivation('main', mainSource);

  const capturedHeader = {
    documentId: headerLocation.sourceId,
    fileName: 'header.h',
    sourceRevision: 0,
    source: headerSource,
  };
  assert.equal(matchesCurrentDocument(capturedHeader, {
    documentId: headerLocation.sourceId,
    fileName: 'renamed.h',
    sourceRevision: headerSession.sourceRevision,
    source: headerSession.snapshot.text,
  }), false);
  const reactivatedHeader = store.requestActivation(headerLocation.sourceId, headerSource);
  assert.equal(reactivatedHeader?.snapshot.text, 'int locally_edited_header;\n');
  assert.equal(reactivatedHeader?.history.canUndo(), true);

  const withoutOriginal = deleteWorkspaceFile(renamedWorkspace, headerLocation.sourceId);
  const withReplacement = addWorkspaceFile(withoutOriginal, {
    id: 'header-replacement-id',
    name: 'header.h',
    source: 'int replacement_header;\n',
  });
  assert.equal(withReplacement.files.find(file => file.name === 'header.h')?.id, 'header-replacement-id');
  assert.equal(selectWorkspaceFile(withReplacement, headerLocation.sourceId), withReplacement);
});

test('rapid diagnostic target requests during IME composition activate only the latest captured ID', () => {
  const { mainSource, headerSource, makefileSource, summary } = createCapturedRun();
  const headerLocation = summary.diagnosticLocations.find(location => location.file === 'header.h');
  const makefileLocation = summary.diagnosticLocations.find(location => location.file === 'Makefile');
  assert.ok(headerLocation);
  assert.ok(makefileLocation);

  const store = new EditorSessionStore('main-id', mainSource, editorSnapshot(mainSource));
  const main = store.active;
  const replacement = 'int edited_main;\n';
  assert.equal(replaceEditorSessionText(main, replacement)?.status, 'applied');
  store.beginComposition();
  const imeCommitted = {
    ...main.snapshot,
    text: `${replacement}/* committed */\n`,
  };
  main.history.record(main.snapshot, imeCommitted);
  updateEditorSessionSnapshot(main, imeCommitted);

  assert.equal(store.requestActivation(headerLocation.sourceId, headerSource), null);
  assert.equal(store.requestActivation(makefileLocation.sourceId, makefileSource), null);
  assert.equal(store.activeId, 'main-id');
  assert.equal(store.finishComposition()?.documentId, makefileLocation.sourceId);
  assert.equal(store.get(headerLocation.sourceId), undefined);
  assert.equal(store.activeId, makefileLocation.sourceId);
  assert.equal(main.snapshot.text, `${replacement}/* committed */\n`);
  assert.equal(main.history.canUndo(), true);
  assert.equal(main.history.undo(main.snapshot)?.text, replacement);
});

test('successive pending location requests retain only the newest target and coordinates', () => {
  const { mainSource, headerSource, makefileSource, summary } = createCapturedRun();
  const headerLocation = summary.diagnosticLocations.find(location => location.file === 'header.h');
  const makefileLocation = summary.diagnosticLocations.find(location => location.file === 'Makefile');
  assert.ok(headerLocation);
  assert.ok(makefileLocation);

  const store = new EditorSessionStore('main-id', mainSource, editorSnapshot(mainSource));
  store.beginComposition();
  const first = store.requestLocationNavigation(
    headerLocation.sourceId,
    headerSource,
    headerLocation.line,
    headerLocation.column,
  );
  const latest = store.requestLocationNavigation(
    makefileLocation.sourceId,
    makefileSource,
    makefileLocation.line,
    makefileLocation.column,
  );

  assert.equal(first.session, null);
  assert.equal(latest.session, null);
  assert.ok(latest.requestId > first.requestId);
  assert.equal(store.activeId, 'main-id');

  const activated = store.finishComposition();
  assert.equal(activated?.documentId, makefileLocation.sourceId);
  assert.deepEqual(store.consumeLocationNavigation(activated.documentId), {
    requestId: latest.requestId,
    documentId: makefileLocation.sourceId,
    line: makefileLocation.line,
    column: makefileLocation.column,
  });
  assert.equal(store.consumeLocationNavigation(headerLocation.sourceId), null);
});

test('an IME-delayed location request is consumed only after its target ID activates', () => {
  const { mainSource, headerSource, makefileSource, summary } = createCapturedRun();
  const headerLocation = summary.diagnosticLocations.find(location => location.file === 'header.h');
  const makefileLocation = summary.diagnosticLocations.find(location => location.file === 'Makefile');
  assert.ok(headerLocation);
  assert.ok(makefileLocation);

  const store = new EditorSessionStore('main-id', mainSource, editorSnapshot(mainSource));
  store.beginComposition();
  const request = store.requestLocationNavigation(
    headerLocation.sourceId,
    headerSource,
    headerLocation.line,
    headerLocation.column,
  );

  assert.equal(request.session, null);
  assert.equal(store.activeId, 'main-id');
  // A navigation to a different file replaces the IME activation target.
  store.cancelLocationNavigationUnless(makefileLocation.sourceId);
  store.requestActivation(makefileLocation.sourceId, makefileSource);
  const activated = store.finishComposition();

  assert.equal(activated?.documentId, makefileLocation.sourceId);
  assert.equal(store.consumeLocationNavigation(activated.documentId), null);

  const matchingStore = new EditorSessionStore('main-id', mainSource, editorSnapshot(mainSource));
  matchingStore.beginComposition();
  const matchingRequest = matchingStore.requestLocationNavigation(
    headerLocation.sourceId,
    headerSource,
    headerLocation.line,
    headerLocation.column,
  );
  const matchingActivation = matchingStore.finishComposition();

  assert.equal(matchingActivation?.documentId, headerLocation.sourceId);
  assert.deepEqual(matchingStore.consumeLocationNavigation(matchingActivation.documentId), {
    requestId: matchingRequest.requestId,
    documentId: headerLocation.sourceId,
    line: headerLocation.line,
    column: headerLocation.column,
  });
});

test('source resolution follows an exact renamed ID and rejects a replacement with the same filename', () => {
  const { sourceSnapshot, summary } = createCapturedRun();
  const location = summary.diagnosticLocations.find(item => item.file === 'header.h');
  assert.ok(location);

  const renamedFiles = sourceSnapshot.files.map(file => file.id === location.sourceId
    ? { ...file, name: 'renamed-header.h' }
    : file);
  const renamedResolution = resolveEditorSourceLocation(location, renamedFiles, sourceSnapshot.files);
  assert.equal(renamedResolution.status, 'available');
  assert.equal(renamedResolution.documentId, location.sourceId);
  assert.equal(renamedResolution.fileName, 'renamed-header.h');
  assert.equal(renamedResolution.offset, 4);

  const replacementFiles = [
    ...sourceSnapshot.files.filter(file => file.id !== location.sourceId),
    { id: 'header-replacement-id', name: location.file, source: 'int replacement_header;\n' },
  ];
  assert.deepEqual(
    resolveEditorSourceLocation(location, replacementFiles, sourceSnapshot.files),
    { status: 'unavailable', reason: 'missing-source' },
  );
});

test('a location request clamps against the existing edited session without changing code or history', () => {
  const { mainSource, headerSource, sourceSnapshot, summary } = createCapturedRun();
  const location = summary.diagnosticLocations.find(item => item.file === 'header.h');
  assert.ok(location);

  const store = new EditorSessionStore('main-id', mainSource, editorSnapshot(mainSource));
  const session = store.requestActivation(location.sourceId, headerSource);
  assert.ok(session);
  assert.equal(replaceEditorSessionText(session, 'x')?.status, 'applied');
  store.requestActivation('main-id', mainSource);
  const editedSnapshot = session.snapshot;
  const sourceRevision = session.sourceRevision;
  const canUndo = session.history.canUndo();
  const canRedo = session.history.canRedo();
  const currentFiles = sourceSnapshot.files.map(file => file.id === location.sourceId
    ? { ...file, source: session.snapshot.text }
    : file);
  const resolution = resolveEditorSourceLocation(location, currentFiles, sourceSnapshot.files);
  assert.equal(resolution.status, 'available');
  assert.equal(resolution.offset, 1, 'the old column clamps to the end of the edited line');

  const request = store.requestLocationNavigation(
    location.sourceId,
    headerSource,
    location.line,
    location.column,
  );

  assert.equal(request.session, session);
  assert.equal(store.activeId, location.sourceId);
  assert.equal(store.consumeLocationNavigation(location.sourceId)?.requestId, request.requestId);
  assert.equal(session.snapshot, editedSnapshot);
  assert.equal(session.snapshot.text, 'x');
  assert.equal(session.sourceRevision, sourceRevision);
  assert.equal(session.history.canUndo(), canUndo);
  assert.equal(session.history.canRedo(), canRedo);
});
