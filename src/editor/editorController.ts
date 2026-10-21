import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  EditorSessionStore,
  publishEditorSessionSource,
  replaceEditorSessionText,
  updateEditorSessionSnapshot,
} from './editorSessions.ts';
import type { EditorSession } from './editorSessions.ts';
import {
  evaluateEditorCommand,
  evaluateNativeEdit,
  getCursorPosition,
  reconcileNativeEdit,
} from './operations.ts';
import {
  EDITOR_LINE_LIMIT_MESSAGE,
  getEditorLineLimitDiagnostic,
  isEditorTextWithinLineLimit,
  normalizeEditorText,
} from './limits.ts';
import { getPlaygroundShortcut } from '../keyboardShortcuts.ts';
import type { EditorCommand, EditorSnapshot } from './types.ts';
import type { EditorLanguage } from './languageMode.ts';
import type { EditorCommandEvaluation } from './operations.ts';
import type { CompletionTrigger } from './completionProvider.ts';
import { getCompletionKeyAction, isEditorCompositionEvent } from './completionInteractions.ts';
import {
  expectedNativeText,
  getSelection,
  getViewport,
  inputCommand,
  isEditorMutationBlocked,
  keepCaretVisible,
  sameSelection,
} from './editorEditing.ts';
import type { EditorViewport } from './editorEditing.ts';
import { createEditorCompletionController } from './editorCompletionController.ts';
import type { ActiveEditorCompletion, EditorCompletionState } from './editorCompletionController.ts';
import { getEditorSourceLocationOffset } from './editorDiagnostics.ts';
import { isFileTransfer } from './fileDropImport.ts';

interface PendingInput {
  before: EditorSnapshot;
  viewport: EditorViewport;
  literal: boolean;
  command?: EditorCommand;
  evaluation?: EditorCommandEvaluation;
}

interface EditorCallbacks {
  onCompositionChange?: (composing: boolean) => void;
  completionEnabled?: boolean;
  readOnly?: boolean;
  canMutate?: () => boolean;
}

interface CapturedEditorSource {
  documentId: string;
  sourceRevision: number;
  source: string;
}

export interface EditorSourceLocationNavigation {
  readonly documentId: string;
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

export function useCodeEditor(
  documentId: string,
  initialText = '',
  onSourceChange?: (documentId: string, source: string) => void,
  callbacks: EditorCallbacks = {},
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const completionEnabled = (callbacks.completionEnabled ?? false) && callbacks.readOnly !== true;
  const completionEnabledRef = useRef(completionEnabled);
  completionEnabledRef.current = completionEnabled;
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [isComposing, setIsComposing] = useState(false);
  const [completion, setCompletion] = useState<EditorCompletionState | null>(null);
  const completionRef = useRef<ActiveEditorCompletion | null>(null);
  const completionRefreshRef = useRef<(trigger?: CompletionTrigger) => void>(() => {});
  const completionAcceptRef = useRef<(index: number) => boolean>(() => false);
  const completionDismissRef = useRef<() => void>(() => {});
  const replaceTextRef = useRef<(replacement: string, targetSession: EditorSession) => boolean>(() => false);
  const sourceLocationNavigationRef = useRef<(request: EditorSourceLocationNavigation) => boolean>(() => false);
  const acceptCompletion = useCallback((index: number) => completionAcceptRef.current(index), []);
  const dismissCompletionFromViewport = useCallback(() => completionDismissRef.current(), []);
  const replaceText = useCallback((replacement: string, targetDocumentId?: string) => {
    const store = sessionStoreRef.current;
    const targetSession = targetDocumentId ? store?.get(targetDocumentId) : store?.active;
    return targetSession ? replaceTextRef.current(replacement, targetSession) : false;
  }, []);
  const navigateToSourceLocation = useCallback((request: EditorSourceLocationNavigation) => (
    sourceLocationNavigationRef.current(request)
  ), []);
  const onSourceChangeRef = useRef(onSourceChange);
  onSourceChangeRef.current = onSourceChange;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const normalizedInitialText = normalizeEditorText(initialText);
  const initialDiagnostic = getEditorLineLimitDiagnostic(normalizedInitialText);
  const initialSessionText = initialDiagnostic ? '' : normalizedInitialText;
  const sessionStoreRef = useRef<EditorSessionStore | null>(null);
  if (sessionStoreRef.current === null) {
    sessionStoreRef.current = new EditorSessionStore(documentId, initialSessionText, {
      text: initialSessionText,
      selection: { start: 0, end: 0, direction: 'none' },
      pairs: [],
    });
  }
  const [activeDocumentId, setActiveDocumentId] = useState(documentId);
  const switchDocumentRef = useRef<(documentId: string, source: string) => void>(() => {});
  const captureDocumentRef = useRef<() => CapturedEditorSource>(() => ({
    documentId,
    sourceRevision: 0,
    source: initialSessionText,
  }));
  const captureDocumentSource = useCallback(() => captureDocumentRef.current(), []);
  const [text, setText] = useState(initialSessionText);
  const [limitMessage, setLimitMessage] = useState(initialDiagnostic);
  const removeDocumentSession = useCallback((nextDocumentId: string) => {
    return sessionStoreRef.current?.removeDocument(nextDocumentId) ?? false;
  }, []);

  useLayoutEffect(() => {
    const editor = ref.current;
    if (!editor) return;
    const activeEditor = editor;
    const getActiveEditorLanguage = (): EditorLanguage => activeEditor.dataset.editorLanguage === 'makefile'
      ? 'makefile' : 'c';
    let activeSession = sessionStoreRef.current!.active;

    editor.value = activeSession.snapshot.text;
    editor.setSelectionRange(activeSession.snapshot.selection.start, activeSession.snapshot.selection.end,
      activeSession.snapshot.selection.direction);

    const measure = document.createElement('canvas').getContext('2d');
    activeSession.viewport = getViewport(editor);
    let pending: PendingInput | null = null;
    let literalInput = false;
    let suppressPairs = false;
    let exitOnTab = false;
    let composing = false;
    let compositionBefore: EditorSnapshot | null = null;
    let compositionViewport: EditorViewport | null = null;
    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
    let writing = false;
    const completionController = createEditorCompletionController({
      editor: activeEditor,
      completionEnabledRef,
      completionRef,
      setCompletion,
      isComposing: () => composing || compositionBefore !== null,
      isReadOnly,
      capture,
      finishComposition,
      measure,
      getHistory: () => activeSession.history,
      resetPendingInput: () => {
        pending = null;
        literalInput = false;
        suppressPairs = false;
      },
      setLimitMessage,
      write,
    });
    const {
      refreshCompletion,
      dismissCompletion,
      acceptCompletionAt,
      moveCompletionSelection,
    } = completionController;
    completionRefreshRef.current = refreshCompletion;
    completionAcceptRef.current = acceptCompletionAt;
    completionDismissRef.current = () => dismissCompletion(true);

    function isReadOnly() {
      return isEditorMutationBlocked(
        callbacksRef.current.readOnly === true,
        callbacksRef.current.canMutate,
      );
    }

    function replaceSource(replacement: string, targetSession: EditorSession) {
      if (isReadOnly()) return false;
      targetSession.history.breakGroup();
      finishComposition(true);
      const targetIsActive = activeSession === targetSession;
      const before = targetIsActive ? capture() : targetSession.snapshot;
      const evaluation = replaceEditorSessionText(targetSession, replacement);
      if (!evaluation) return false;
      if (evaluation.status === 'line-limit') {
        if (targetIsActive) rejectLimit(before);
        return false;
      }

      const result = evaluation.snapshot;
      pending = null;
      literalInput = false;
      suppressPairs = false;
      exitOnTab = false;
      dismissCompletion();
      if (targetIsActive) {
        setLimitMessage(null);
        write(result);
      } else {
        publishEditorSessionSource(
          targetSession,
          result.text,
          (sessionId, source) => onSourceChangeRef.current?.(sessionId, source),
        );
      }
      return true;
    }

    replaceTextRef.current = replaceSource;

    function publishEditorState(persistSource = true, refreshSuggestions = persistSource) {
      setText(activeSession.snapshot.text);
      if (persistSource) {
        publishEditorSessionSource(
          activeSession,
          activeSession.snapshot.text,
          (sessionId, source) => onSourceChangeRef.current?.(sessionId, source),
        );
      }
      const next = getCursorPosition(activeSession.snapshot);
      setCursor((current) => current.line === next.line && current.column === next.column ? current : next);
      if (refreshSuggestions) {
        if (getActiveEditorLanguage() === 'c') refreshCompletion();
        else dismissCompletion();
      }
    }

    function write(next: EditorSnapshot, viewport?: EditorViewport, keepVisible = true, refreshSuggestions = true) {
      const targetViewport = viewport ?? activeSession.viewport;
      writing = true;
      updateEditorSessionSnapshot(activeSession, next);
      if (editor!.value !== next.text) editor!.value = next.text;
      editor!.setSelectionRange(next.selection.start, next.selection.end, next.selection.direction);
      editor!.scrollTop = targetViewport.scrollTop;
      editor!.scrollLeft = targetViewport.scrollLeft;
      if (keepVisible) keepCaretVisible(editor!, next, measure);
      activeSession.viewport = getViewport(editor!);
      writing = false;
      publishEditorState(true, refreshSuggestions);
    }

    function applyPendingSourceLocationNavigation(documentId: string): boolean {
      const store = sessionStoreRef.current!;
      if (composing || compositionBefore !== null || !editor!.isConnected) return false;
      if (activeSession.documentId !== documentId) {
        store.cancelLocationNavigation();
        return false;
      }
      const request = store.consumeLocationNavigation(documentId);
      if (!request) return false;

      const offset = getEditorSourceLocationOffset(activeSession.snapshot.text, request.line, request.column, true);
      if (offset === null) return false;

      activeSession.history.breakGroup();
      dismissCompletion();
      editor!.focus({ preventScroll: true });
      write({
        ...activeSession.snapshot,
        selection: { start: offset, end: offset, direction: 'none' },
      }, undefined, true, false);
      return true;
    }

    function activateSession(nextSession: EditorSession) {
      if (nextSession.documentId === activeSession.documentId) return;
      activeSession.history.breakGroup();
      pending = null;
      literalInput = false;
      suppressPairs = false;
      exitOnTab = false;
      dismissCompletion();

      activeSession = nextSession;
      const next = activeSession.snapshot;
      writing = true;
      editor!.value = next.text;
      editor!.setSelectionRange(next.selection.start, next.selection.end, next.selection.direction);
      editor!.scrollTop = activeSession.viewport.scrollTop;
      editor!.scrollLeft = activeSession.viewport.scrollLeft;
      activeSession.viewport = getViewport(editor!);
      writing = false;

      setLimitMessage(getEditorLineLimitDiagnostic(next.text));
      setText(next.text);
      const nextCursor = getCursorPosition(next);
      setCursor(current => current.line === nextCursor.line && current.column === nextCursor.column
        ? current : nextCursor);
      setActiveDocumentId(nextSession.documentId);
      if (getActiveEditorLanguage() === 'c') refreshCompletion();
      else dismissCompletion();
      applyPendingSourceLocationNavigation(nextSession.documentId);
    }

    function requestDocumentActivation(nextDocumentId: string, source: string) {
      sessionStoreRef.current!.cancelLocationNavigationUnless(nextDocumentId);
      if (nextDocumentId === activeSession.documentId) {
        sessionStoreRef.current!.requestActivation(nextDocumentId, source);
        return;
      }
      if (composing || compositionBefore !== null) {
        sessionStoreRef.current!.requestActivation(nextDocumentId, source);
        return;
      }

      capture();
      const nextSession = sessionStoreRef.current!.requestActivation(nextDocumentId, source);
      if (nextSession) activateSession(nextSession);
    }

    function requestSourceLocationNavigation(request: EditorSourceLocationNavigation): boolean {
      const store = sessionStoreRef.current!;
      const compositionPending = composing || compositionBefore !== null;
      if (!compositionPending) capture();
      const navigation = store.requestLocationNavigation(
        request.documentId,
        request.source,
        request.line,
        request.column,
      );
      if (compositionPending) return true;

      if (navigation.session) {
        if (navigation.session.documentId !== activeSession.documentId) activateSession(navigation.session);
        applyPendingSourceLocationNavigation(request.documentId);
        return true;
      }
      return false;
    }

    sourceLocationNavigationRef.current = requestSourceLocationNavigation;

    function captureDocument() {
      const current = capture();
      return {
        documentId: activeSession.documentId,
        sourceRevision: activeSession.sourceRevision,
        source: current.text,
      };
    }

    function rejectLimit(before: EditorSnapshot, viewport: EditorViewport = activeSession.viewport) {
      setLimitMessage(EDITOR_LINE_LIMIT_MESSAGE);
      pending = null;
      literalInput = false;
      suppressPairs = false;
      write(before, viewport, false);
    }

    function capture() {
      if (writing) return activeSession.snapshot;
      const snapshot = activeSession.snapshot;
      const currentText = normalizeEditorText(editor!.value);
      const sourceIsReadOnly = isEditorMutationBlocked(
        callbacksRef.current.readOnly === true,
        currentText === snapshot.text ? undefined : callbacksRef.current.canMutate,
      );
      if (sourceIsReadOnly) {
        let selection = getSelection(editor!);
        if (currentText !== snapshot.text) {
          const maxOffset = snapshot.text.length;
          selection = {
            start: Math.min(selection.start, maxOffset),
            end: Math.min(selection.end, maxOffset),
            direction: selection.direction,
          };
          editor!.value = snapshot.text;
          editor!.setSelectionRange(selection.start, selection.end, selection.direction);
        }
        const next = sameSelection(snapshot.selection, selection) ? snapshot : { ...snapshot, selection };
        updateEditorSessionSnapshot(activeSession, next);
        activeSession.viewport = getViewport(editor!);
        publishEditorState(false, false);
        return activeSession.snapshot;
      }
      const selection = getSelection(editor!);
      if (currentText !== activeSession.snapshot.text) {
        const evaluation = evaluateNativeEdit(activeSession.snapshot, currentText, selection);
        if (!compositionBefore && evaluation.status === 'line-limit') {
          rejectLimit(activeSession.snapshot);
          return activeSession.snapshot;
        }
        const next = evaluation.snapshot;
        if (!compositionBefore) {
          activeSession.history.record(activeSession.snapshot, next);
          setLimitMessage(null);
        }
        updateEditorSessionSnapshot(activeSession, next);
      } else if (!sameSelection(activeSession.snapshot.selection, selection)) {
        activeSession.history.breakGroup();
        updateEditorSessionSnapshot(activeSession, { ...activeSession.snapshot, selection });
      }
      activeSession.viewport = getViewport(editor!);
      if (!compositionBefore || isEditorTextWithinLineLimit(activeSession.snapshot.text)) {
        publishEditorState(!compositionBefore);
      }
      return activeSession.snapshot;
    }

    function finishComposition(force = false) {
      if (compositionTimer !== undefined) clearTimeout(compositionTimer);
      compositionTimer = undefined;
      if (isReadOnly()) {
        if (!compositionBefore && !composing) return;
        capture();
        composing = false;
        compositionBefore = null;
        compositionViewport = null;
        pending = null;
        literalInput = false;
        suppressPairs = false;
        setIsComposing(false);
        callbacksRef.current.onCompositionChange?.(false);
        const nextSession = sessionStoreRef.current!.finishComposition();
        if (nextSession) activateSession(nextSession);
        return;
      }
      if (!compositionBefore || (composing && !force)) return;
      composing = false;
      capture();
      const evaluation = evaluateNativeEdit(compositionBefore, activeSession.snapshot.text, activeSession.snapshot.selection);
      if (evaluation.status === 'line-limit') {
        rejectLimit(compositionBefore, compositionViewport ?? activeSession.viewport);
      } else {
        updateEditorSessionSnapshot(activeSession, evaluation.snapshot);
        activeSession.history.record(compositionBefore, activeSession.snapshot);
        setLimitMessage(null);
      }
      compositionBefore = null;
      compositionViewport = null;
      pending = null;
      literalInput = false;
      suppressPairs = false;
      setIsComposing(false);
      publishEditorState();
      callbacksRef.current.onCompositionChange?.(false);
      const nextSession = sessionStoreRef.current!.finishComposition();
      if (nextSession) activateSession(nextSession);
      else applyPendingSourceLocationNavigation(activeSession.documentId);
    }

    function perform(command: EditorCommand) {
      if (isReadOnly()) return false;
      finishComposition();
      const before = capture();
      const evaluation = evaluateEditorCommand(before, command, getActiveEditorLanguage());
      if (evaluation.status === 'line-limit') {
        rejectLimit(before);
        return false;
      }
      if (evaluation.status === 'unsupported') return false;
      const result = evaluation.snapshot;
      pending = null;
      literalInput = false;
      activeSession.history.record(before, result);
      setLimitMessage(null);
      write(result);
      return true;
    }

    function restore(direction: 'undo' | 'redo', before = activeSession.snapshot) {
      if (isReadOnly()) return;
      finishComposition();
      const result = activeSession.history[direction](before);
      pending = null;
      literalInput = false;
      suppressPairs = false;
      dismissCompletion();
      setLimitMessage(null);
      write(result ?? before);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isEditorCompositionEvent(event, composing)) return;
      if (getPlaygroundShortcut(event)) {
        dismissCompletion();
        return;
      }
      if (isReadOnly()) return;
      finishComposition();
      const before = capture();
      const language = getActiveEditorLanguage();
      const altGraph = event.getModifierState('AltGraph');
      const modified = !altGraph && (event.ctrlKey || event.metaKey || event.altKey);
      suppressPairs = modified;
      const mayExit = exitOnTab;
      exitOnTab = false;

      const manualCompletion = language === 'c' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && (event.code === 'Space' || event.key === ' ');
      if (manualCompletion) {
        event.preventDefault();
        activeSession.history.breakGroup();
        refreshCompletion('manual');
        return;
      }

      const activeCompletion = language === 'c' ? completionRef.current : null;
      const completionAction = getCompletionKeyAction(
        event.key,
        activeCompletion !== null,
        modified,
        event.shiftKey,
      );
      if (completionAction === 'move-next' || completionAction === 'move-previous') {
        event.preventDefault();
        moveCompletionSelection(completionAction === 'move-next' ? 1 : -1);
        return;
      }
      if (completionAction === 'dismiss') {
        event.preventDefault();
        activeSession.history.breakGroup();
        dismissCompletion(true);
        return;
      }
      if (completionAction === 'accept' && activeCompletion) {
        event.preventDefault();
        activeSession.history.breakGroup();
        acceptCompletionAt(activeCompletion.selectedIndex);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        restore(event.shiftKey ? 'redo' : 'undo', before);
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        restore('redo', before);
        return;
      }
      if (event.key === 'Escape' && !modified) {
        activeSession.history.breakGroup();
        exitOnTab = true;
        return;
      }
      if (event.key === 'Tab' && !modified) {
        activeSession.history.breakGroup();
        if (mayExit) return;
        event.preventDefault();
        perform({ type: 'indent', outdent: event.shiftKey });
        return;
      }
      if (event.key === 'Enter' && !modified) {
        event.preventDefault();
        perform({ type: 'enter' });
        return;
      }
      if (event.key === 'Backspace' && !modified && perform({ type: 'backspace' })) {
        event.preventDefault();
        return;
      }
      pending = { before, viewport: activeSession.viewport, literal: false };
    }

    function onBeforeInput(event: Event) {
      const input = event as InputEvent;
      if (isReadOnly()) {
        if (event.cancelable) event.preventDefault();
        pending = null;
        literalInput = false;
        suppressPairs = false;
        capture();
        return;
      }
      if (input.isComposing || composing || compositionBefore) return;
      const before = capture();
      if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
        if (event.cancelable) {
          event.preventDefault();
          restore(input.inputType === 'historyUndo' ? 'undo' : 'redo', before);
        } else {
          pending = { before, viewport: activeSession.viewport, literal: true };
        }
        return;
      }

      const literal = literalInput || (input.inputType !== 'insertText'
        && input.inputType !== 'deleteContentBackward'
        && input.inputType !== 'deleteContentForward'
        && input.inputType !== 'insertLineBreak' && input.inputType !== 'insertParagraph');
      const command = literal || suppressPairs ? undefined : inputCommand(input);
      const evaluation = command
        ? evaluateEditorCommand(before, command, getActiveEditorLanguage()) : undefined;
      if (evaluation?.status === 'line-limit') {
        if (event.cancelable) {
          event.preventDefault();
          rejectLimit(before, activeSession.viewport);
        } else {
          pending = { before, viewport: activeSession.viewport, literal: true };
        }
        return;
      }
      const result = evaluation?.status === 'applied' ? evaluation.snapshot : null;
      if (result && event.cancelable) {
        event.preventDefault();
        activeSession.history.record(before, result);
        pending = null;
        literalInput = false;
        suppressPairs = false;
        setLimitMessage(null);
        write(result);
      } else {
        pending = { before, viewport: activeSession.viewport, literal, command, evaluation };
      }
    }

    function onInput(event: Event) {
      const input = event as InputEvent;
      if (isReadOnly()) {
        if (composing || compositionBefore !== null) finishComposition(true);
        else capture();
        pending = null;
        literalInput = false;
        suppressPairs = false;
        return;
      }
      if (composing || input.isComposing || compositionBefore) {
        updateEditorSessionSnapshot(activeSession,
          reconcileNativeEdit(activeSession.snapshot, editor!.value, getSelection(editor!)));
        activeSession.viewport = getViewport(editor!);
        pending = null;
        if (isEditorTextWithinLineLimit(activeSession.snapshot.text)) publishEditorState(false);
        return;
      }
      const before = pending?.before ?? activeSession.snapshot;
      const viewport = pending?.viewport ?? activeSession.viewport;
      if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
        restore(input.inputType === 'historyUndo' ? 'undo' : 'redo', before);
        return;
      }

      const literal = literalInput || pending?.literal === true;
      const command = literal || suppressPairs ? undefined : pending?.command ?? inputCommand(input);
      const nativeEvaluation = evaluateNativeEdit(before, editor!.value, getSelection(editor!));
      if (nativeEvaluation.status === 'line-limit') {
        rejectLimit(before, viewport);
        return;
      }
      const nativeNext = nativeEvaluation.snapshot;
      const evaluation = command
        ? pending?.evaluation ?? evaluateEditorCommand(before, command, getActiveEditorLanguage())
        : undefined;
      const result = evaluation?.status === 'applied' ? evaluation.snapshot : undefined;
      if (result && command && nativeNext.text === expectedNativeText(before, command)) {
        activeSession.history.record(before, result);
        setLimitMessage(null);
        write(result);
      } else {
        const kind = !literal && input.inputType === 'insertText' && input.data?.length === 1
          ? 'typing' : !literal && (input.inputType === 'deleteContentBackward'
            || input.inputType === 'deleteContentForward') ? 'delete' : 'action';
        activeSession.history.record(before, nativeNext, { kind });
        setLimitMessage(null);
        updateEditorSessionSnapshot(activeSession, nativeNext);
        activeSession.viewport = getViewport(editor!);
        publishEditorState();
      }
      pending = null;
      literalInput = false;
      suppressPairs = false;
    }

    function onLiteralEdit() {
      if (isReadOnly() || composing) return;
      finishComposition();
      activeSession.history.breakGroup();
      const before = capture();
      pending = { before, viewport: activeSession.viewport, literal: true };
      literalInput = true;
      suppressPairs = false;
    }

    function onPaste(event: ClipboardEvent) {
      if (isReadOnly()) {
        event.preventDefault();
        return;
      }
      onLiteralEdit();
    }

    function onCut(event: ClipboardEvent) {
      if (isReadOnly()) {
        event.preventDefault();
        const selection = getSelection(editor!);
        const selectedText = editor!.value.slice(selection.start, selection.end);
        try {
          event.clipboardData?.setData('text/plain', selectedText);
        } catch {
          // Keep the source unchanged if the browser denies clipboard access.
        }
        capture();
        return;
      }
      onLiteralEdit();
    }

    function onDrop(event: DragEvent) {
      if (isReadOnly()) {
        event.preventDefault();
        return;
      }
      if (isFileTransfer(event.dataTransfer)) {
        event.preventDefault();
        return;
      }
      onLiteralEdit();
    }

    function onCompositionStart() {
      if (isReadOnly()) return;
      if (compositionBefore !== null) {
        if (compositionTimer !== undefined) clearTimeout(compositionTimer);
        compositionTimer = undefined;
        composing = true;
        return;
      }
      finishComposition();
      dismissCompletion();
      sessionStoreRef.current!.beginComposition();
      composing = true;
      compositionBefore = capture();
      compositionViewport = activeSession.viewport;
      setIsComposing(true);
      callbacksRef.current.onCompositionChange?.(true);
      exitOnTab = false;
      pending = null;
      activeSession.history.breakGroup();
    }

    function onCompositionEnd() {
      if (isReadOnly()) {
        finishComposition(true);
        return;
      }
      composing = false;
      capture();
      // Some browsers dispatch their final input after compositionend.
      compositionTimer = setTimeout(finishComposition, 0);
    }

    function onSelectionChange() {
      if (document.activeElement === editor) capture();
    }

    function onKeyUp() {
      suppressPairs = false;
      capture();
      pending = null;
    }

    function onBlur() {
      exitOnTab = false;
      activeSession.history.breakGroup();
      dismissCompletion();
      if (isReadOnly()) {
        capture();
        pending = null;
        suppressPairs = false;
        return;
      }
      sessionStoreRef.current!.handleBlur(() => {
        capture();
        if (isEditorTextWithinLineLimit(activeSession.snapshot.text)) {
          publishEditorSessionSource(
            activeSession,
            activeSession.snapshot.text,
            (sessionId, source) => onSourceChangeRef.current?.(sessionId, source),
          );
        }
      }, () => finishComposition(true));
      pending = null;
      suppressPairs = false;
    }

    switchDocumentRef.current = requestDocumentActivation;
    captureDocumentRef.current = captureDocument;

    editor.addEventListener('keydown', onKeyDown);
    editor.addEventListener('keyup', onKeyUp);
    editor.addEventListener('beforeinput', onBeforeInput);
    editor.addEventListener('input', onInput);
    editor.addEventListener('select', onSelectionChange);
    editor.addEventListener('click', onSelectionChange);
    editor.addEventListener('paste', onPaste);
    editor.addEventListener('cut', onCut);
    editor.addEventListener('drop', onDrop);
    editor.addEventListener('compositionstart', onCompositionStart);
    editor.addEventListener('compositionend', onCompositionEnd);
    editor.addEventListener('blur', onBlur);
    document.addEventListener('selectionchange', onSelectionChange);
    publishEditorState();

    return () => {
      if (compositionTimer !== undefined) clearTimeout(compositionTimer);
      editor.removeEventListener('keydown', onKeyDown);
      editor.removeEventListener('keyup', onKeyUp);
      editor.removeEventListener('beforeinput', onBeforeInput);
      editor.removeEventListener('input', onInput);
      editor.removeEventListener('select', onSelectionChange);
      editor.removeEventListener('click', onSelectionChange);
      editor.removeEventListener('paste', onPaste);
      editor.removeEventListener('cut', onCut);
      editor.removeEventListener('drop', onDrop);
      editor.removeEventListener('compositionstart', onCompositionStart);
      editor.removeEventListener('compositionend', onCompositionEnd);
      editor.removeEventListener('blur', onBlur);
      document.removeEventListener('selectionchange', onSelectionChange);
      switchDocumentRef.current = () => {};
      captureDocumentRef.current = () => ({
        documentId: sessionStoreRef.current!.active.documentId,
        sourceRevision: sessionStoreRef.current!.active.sourceRevision,
        source: sessionStoreRef.current!.active.snapshot.text,
      });
      completionRefreshRef.current = () => {};
      completionAcceptRef.current = () => false;
      completionDismissRef.current = () => {};
      replaceTextRef.current = () => false;
      sourceLocationNavigationRef.current = () => false;
    };
  }, []);

  useLayoutEffect(() => {
    switchDocumentRef.current(documentId, initialSessionText);
  }, [documentId, initialSessionText]);

  useLayoutEffect(() => {
    if (!completionEnabled) {
      completionRef.current = null;
      setCompletion(null);
      return;
    }
    completionRefreshRef.current('automatic');
  }, [completionEnabled]);

  return {
    ref,
    activeDocumentId,
    cursor,
    text,
    captureDocumentSource,
    removeDocumentSession,
    limitMessage,
    isComposing,
    completion: completionEnabled ? completion : null,
    acceptCompletion,
    dismissCompletion: dismissCompletionFromViewport,
    replaceText,
    navigateToSourceLocation,
  };
}
