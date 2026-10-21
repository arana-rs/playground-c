import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EditorSessionStore,
  publishEditorSessionSource,
  replaceEditorSessionText,
  updateEditorSessionSnapshot,
} from '../src/editor/editorSessions.ts';
import { evaluateEditorCommand, evaluateNativeEdit } from '../src/editor/operations.ts';

const snapshot = (text = '') => ({
  text,
  selection: { start: 0, end: 0, direction: 'none' },
  pairs: [],
});

function type(session, character) {
  const before = session.snapshot;
  const result = evaluateEditorCommand(before, { type: 'type', character });
  const next = result.status === 'applied'
    ? result.snapshot
    : evaluateNativeEdit(before, before.text.slice(0, before.selection.start) + character
      + before.text.slice(before.selection.end), {
      start: before.selection.start + character.length,
      end: before.selection.start + character.length,
      direction: 'none',
    }).snapshot;
  session.history.record(before, next);
  updateEditorSessionSnapshot(session, next);
}

function switchTo(store, documentId, source) {
  const session = store.requestActivation(documentId, source);
  assert.ok(session);
  return session;
}

test('document sessions keep independent edit history, selection, viewport, and delimiter pairs', () => {
  const store = new EditorSessionStore('a', '', snapshot());
  const a = store.active;
  type(a, '(');
  type(a, 'x');
  updateEditorSessionSnapshot(a, {
    ...a.snapshot,
    selection: { start: 1, end: 2, direction: 'backward' },
  });
  a.viewport = { scrollTop: 72, scrollLeft: 11 };

  const b = switchTo(store, 'b', '');
  type(b, '{');
  const bEdited = structuredClone(b.snapshot);

  const restoredA = switchTo(store, 'a', 'stale workspace echo');
  assert.equal(restoredA, a, 'returning to an existing ID reuses its session');
  assert.equal(restoredA.snapshot.text, '(x)');
  assert.deepEqual(restoredA.snapshot.selection, { start: 1, end: 2, direction: 'backward' });
  assert.equal(restoredA.snapshot.pairs.length, 1);
  assert.deepEqual(restoredA.viewport, { scrollTop: 72, scrollLeft: 11 });

  const aUndone = restoredA.history.undo(restoredA.snapshot);
  assert.equal(aUndone?.text, '()');
  assert.equal(aUndone?.pairs.length, 1);
  updateEditorSessionSnapshot(restoredA, aUndone);
  assert.equal(restoredA.history.canRedo(), true);

  const restoredB = switchTo(store, 'b', 'stale b source');
  assert.deepEqual(restoredB.snapshot, bEdited);
  const bUndone = restoredB.history.undo(restoredB.snapshot);
  assert.equal(bUndone?.text, '');
  assert.equal(bUndone?.pairs.length, 0);
  updateEditorSessionSnapshot(restoredB, bUndone);
  const bRedone = restoredB.history.redo(restoredB.snapshot);
  assert.equal(bRedone?.text, '{}');
  updateEditorSessionSnapshot(restoredB, bRedone);

  const aWithRedo = switchTo(store, 'a', 'stale workspace echo');
  assert.equal(aWithRedo.snapshot.text, '()');
  assert.equal(aWithRedo.history.canRedo(), true);
  const aRedone = aWithRedo.history.redo(aWithRedo.snapshot);
  assert.equal(aRedone?.text, '(x)');
  assert.deepEqual(aRedone?.selection, { start: 1, end: 2, direction: 'backward' });
  assert.equal(aRedone?.pairs.length, 1);
});

test('blur during an IME transaction does not flush the pending document activation', () => {
  const store = new EditorSessionStore('a', 'before', snapshot('before'));
  const a = store.active;
  store.beginComposition();

  assert.equal(store.requestActivation('b', 'target source'), null);
  assert.equal(store.activeId, 'a');
  assert.equal(store.isCompositionPending, true, 'blur must leave the composition lock in place');

  let forcedFinishCount = 0;
  store.handleBlur(
    () => publishEditorSessionSource(a, a.snapshot.text),
    () => {
      forcedFinishCount++;
      store.finishComposition();
    },
  );
  assert.equal(forcedFinishCount, 0);
  assert.equal(store.activeId, 'a');

  updateEditorSessionSnapshot(a, {
    ...a.snapshot,
    text: 'before界',
    selection: { start: 7, end: 7, direction: 'none' },
  });
  const updates = [];
  publishEditorSessionSource(a, a.snapshot.text, (documentId, source) => updates.push({ documentId, source }));
  const b = store.finishComposition();

  assert.equal(b?.documentId, 'b');
  assert.equal(store.activeId, 'b');
  assert.equal(store.isCompositionPending, false);
  assert.equal(store.get('a')?.snapshot.text, 'before界');
  assert.equal(b?.snapshot.text, 'target source');
  assert.deepEqual(updates, [{ documentId: 'a', source: 'before界' }]);
});

test('the composition lock stays active through blur while the final-input window remains open', () => {
  const store = new EditorSessionStore('a', '', snapshot());
  const a = store.active;
  store.beginComposition();

  assert.equal(store.requestActivation('b', 'B'), null);
  // compositionend starts the finish timer; blur must not consume the pending activation.
  assert.equal(store.isCompositionPending, true);
  assert.equal(store.activeId, 'a');
  let forcedFinishCount = 0;
  store.handleBlur(
    () => {},
    () => {
      forcedFinishCount++;
      store.finishComposition();
    },
  );
  assert.equal(forcedFinishCount, 0);
  assert.equal(store.activeId, 'a');
  updateEditorSessionSnapshot(a, {
    ...a.snapshot,
    text: 'final input',
    selection: { start: 11, end: 11, direction: 'none' },
  });

  const b = store.finishComposition();
  assert.equal(store.activeId, 'b');
  assert.equal(store.get('a')?.snapshot.text, 'final input');
  assert.equal(b?.snapshot.text, 'B');
});

test('composition requests can cancel a pending switch or replace it with the latest ID', () => {
  const store = new EditorSessionStore('a', '', snapshot());
  store.beginComposition();

  assert.equal(store.requestActivation('b', 'B'), null);
  assert.equal(store.requestActivation('a', 'A'), store.active);
  assert.equal(store.finishComposition(), null, 'returning to A cancels the pending switch to B');
  assert.equal(store.activeId, 'a');

  store.beginComposition();
  assert.equal(store.requestActivation('b', 'B'), null);
  assert.equal(store.requestActivation('c', 'C'), null);
  assert.equal(store.finishComposition()?.documentId, 'c');
  assert.equal(store.get('b'), undefined);
  assert.equal(store.activeId, 'c');
});

test('source publication remains tied to the originating session ID and unchanged echoes are ignored', () => {
  const store = new EditorSessionStore('a', 'a', snapshot('a'));
  const a = store.active;
  updateEditorSessionSnapshot(a, { ...a.snapshot, text: 'edited a' });
  const updates = [];
  publishEditorSessionSource(a, a.snapshot.text, (documentId, source) => updates.push({ documentId, source }));

  const b = switchTo(store, 'b', 'b');
  updateEditorSessionSnapshot(b, { ...b.snapshot, text: 'edited b' });
  publishEditorSessionSource(b, b.snapshot.text, (documentId, source) => updates.push({ documentId, source }));
  publishEditorSessionSource(a, a.snapshot.text, (documentId, source) => updates.push({ documentId, source }));

  assert.deepEqual(updates, [
    { documentId: 'a', source: 'edited a' },
    { documentId: 'b', source: 'edited b' },
  ]);
  assert.equal(store.requestActivation('a', 'stale a echo')?.snapshot.text, 'edited a');
});

test('source revisions change only when session text changes, including edits captured before publication', () => {
  const store = new EditorSessionStore('a', 'before', snapshot('before'));
  const session = store.active;
  assert.equal(session.sourceRevision, 0);

  updateEditorSessionSnapshot(session, {
    ...session.snapshot,
    selection: { start: 2, end: 2, direction: 'none' },
  });
  assert.equal(session.sourceRevision, 0, 'selection changes are not source versions');

  // This is the session update performed when capture() reconciles current DOM text.
  updateEditorSessionSnapshot(session, { ...session.snapshot, text: 'before界' });
  assert.equal(session.sourceRevision, 1);
  publishEditorSessionSource(session, session.snapshot.text);
  assert.equal(session.sourceRevision, 1, 'publication does not count the same edit twice');

  updateEditorSessionSnapshot(session, { ...session.snapshot, text: 'before' });
  assert.equal(session.sourceRevision, 2, 'undo or redo to different text gets a new revision');
});

test('whole-source replacement is one undoable action on the active file and preserves the other file', () => {
  const store = new EditorSessionStore('a', 'source A', snapshot('source A'));
  const a = store.active;
  const b = switchTo(store, 'b', 'source B');
  const updates = [];
  const debugSource = '#include <stdio.h>\nint main(void) {\n    puts("debug");\n}\n';

  const replacement = replaceEditorSessionText(b, debugSource);
  assert.equal(replacement?.status, 'applied');
  assert.equal(b.snapshot.text, debugSource);
  assert.deepEqual(b.snapshot.selection, { start: 0, end: 0, direction: 'none' });
  publishEditorSessionSource(b, b.snapshot.text, (documentId, source) => updates.push({ documentId, source }));
  assert.equal(a.snapshot.text, 'source A');
  assert.deepEqual(updates, [{ documentId: 'b', source: debugSource }]);

  const undone = b.history.undo(b.snapshot);
  assert.equal(undone?.text, 'source B');
  updateEditorSessionSnapshot(b, undone);
  assert.equal(b.history.canRedo(), true);
  const redone = b.history.redo(b.snapshot);
  assert.equal(redone?.text, debugSource);
  updateEditorSessionSnapshot(b, redone);
});

test('replacement remains bound to its captured session after IME commit activates a pending tab', () => {
  const store = new EditorSessionStore('a', 'before', snapshot('before'));
  const a = store.active;
  store.beginComposition();
  assert.equal(store.requestActivation('b', 'untouched B'), null);

  const imeCommitted = {
    ...a.snapshot,
    text: 'before界',
    selection: { start: 7, end: 7, direction: 'none' },
  };
  a.history.record(a.snapshot, imeCommitted);
  updateEditorSessionSnapshot(a, imeCommitted);
  const targetSession = a;
  const b = store.finishComposition();
  assert.equal(b?.documentId, 'b');

  const updates = [];
  const debugSource = 'int main(void) { return 0; }\n';
  const replacement = replaceEditorSessionText(targetSession, debugSource);
  assert.equal(replacement?.status, 'applied');
  publishEditorSessionSource(targetSession, targetSession.snapshot.text,
    (documentId, source) => updates.push({ documentId, source }));
  assert.equal(store.activeId, 'b');
  assert.equal(targetSession.snapshot.text, debugSource);
  assert.equal(b?.snapshot.text, 'untouched B');
  assert.deepEqual(updates, [{ documentId: 'a', source: debugSource }]);

  const undone = targetSession.history.undo(targetSession.snapshot);
  assert.equal(undone?.text, 'before界', 'undo returns to the committed IME text');
  updateEditorSessionSnapshot(targetSession, undone);
  const redone = targetSession.history.redo(targetSession.snapshot);
  assert.equal(redone?.text, debugSource);
  updateEditorSessionSnapshot(targetSession, redone);
});

test('removing an inactive document purges its edit history without disturbing the active session', () => {
  const store = new EditorSessionStore('a', 'A', snapshot('A'));
  const a = store.active;
  const b = switchTo(store, 'b', 'B');
  type(b, 'x');
  switchTo(store, 'a', 'stale A');

  assert.equal(store.removeDocument('b'), true);
  assert.equal(store.get('b'), undefined);
  assert.equal(store.active, a);
  assert.equal(store.active.snapshot.text, 'A');
  assert.equal(store.removeDocument('missing'), false);
});

test('removing the active document waits until another session is active', () => {
  const store = new EditorSessionStore('a', 'A', snapshot('A'));

  assert.equal(store.removeDocument('a'), true);
  assert.ok(store.get('a'), 'the active session remains available until activation is safe');
  const b = switchTo(store, 'b', 'B');
  assert.equal(store.get('a'), undefined, 'the removed session is discarded after switching');
  assert.equal(store.active, b);
});

test('removing a pending target cancels the activation and leaves the composing session intact', () => {
  const store = new EditorSessionStore('a', 'A', snapshot('A'));
  store.beginComposition();

  assert.equal(store.requestActivation('b', 'B'), null);
  assert.equal(store.removeDocument('b'), false);
  assert.equal(store.finishComposition(), null);
  assert.equal(store.activeId, 'a');
  assert.equal(store.get('b'), undefined);
});

test('queued removal publishes the final IME input before dropping the old session', () => {
  const store = new EditorSessionStore('a', 'before', snapshot('before'));
  const a = store.active;
  store.beginComposition();
  assert.equal(store.requestActivation('b', 'target source'), null);
  assert.equal(store.removeDocument('a'), true);

  updateEditorSessionSnapshot(a, {
    ...a.snapshot,
    text: 'before界',
    selection: { start: 7, end: 7, direction: 'none' },
  });
  const updates = [];
  publishEditorSessionSource(a, a.snapshot.text, (documentId, source) => updates.push({ documentId, source }));
  const b = store.finishComposition();

  assert.equal(b?.documentId, 'b');
  assert.equal(store.get('a'), undefined);
  assert.equal(store.active, b);
  assert.deepEqual(updates, [{ documentId: 'a', source: 'before界' }]);
});
