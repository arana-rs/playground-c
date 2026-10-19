import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createEditorHistory } from './history.ts';
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
import { notifyEditorSourceChange } from './sourcePersistence.ts';
import type { EditorCommand, EditorSnapshot } from './types.ts';
import type { EditorCommandEvaluation } from './operations.ts';
import type { CompletionTrigger } from './completionProvider.ts';
import { getCompletionKeyAction, isEditorCompositionEvent } from './completionInteractions.ts';
import {
  expectedNativeText,
  getSelection,
  getViewport,
  inputCommand,
  keepCaretVisible,
  sameSelection,
} from './editorEditing.ts';
import type { EditorViewport } from './editorEditing.ts';
import { createEditorCompletionController } from './editorCompletionController.ts';
import type { ActiveEditorCompletion, EditorCompletionState } from './editorCompletionController.ts';

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
}

export function useCodeEditor(
  initialText = '',
  onSourceChange?: (source: string) => void,
  callbacks: EditorCallbacks = {},
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const completionEnabled = callbacks.completionEnabled ?? false;
  const completionEnabledRef = useRef(completionEnabled);
  completionEnabledRef.current = completionEnabled;
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [isComposing, setIsComposing] = useState(false);
  const [completion, setCompletion] = useState<EditorCompletionState | null>(null);
  const completionRef = useRef<ActiveEditorCompletion | null>(null);
  const completionRefreshRef = useRef<(trigger?: CompletionTrigger) => void>(() => {});
  const completionAcceptRef = useRef<(index: number) => boolean>(() => false);
  const completionDismissRef = useRef<() => void>(() => {});
  const acceptCompletion = useCallback((index: number) => completionAcceptRef.current(index), []);
  const dismissCompletionFromViewport = useCallback(() => completionDismissRef.current(), []);
  const normalizedInitialText = normalizeEditorText(initialText);
  const initialDiagnostic = getEditorLineLimitDiagnostic(normalizedInitialText);
  const [text, setText] = useState(initialDiagnostic ? '' : normalizedInitialText);
  const [limitMessage, setLimitMessage] = useState(initialDiagnostic);

  useLayoutEffect(() => {
    const editor = ref.current;
    if (!editor) return;
    const activeEditor = editor;

    if (initialDiagnostic) editor.value = '';
    editor.setSelectionRange(0, 0);

    let snapshot: EditorSnapshot = { text: normalizeEditorText(editor.value), selection: getSelection(editor), pairs: [] };
    const history = createEditorHistory(snapshot);
    const measure = document.createElement('canvas').getContext('2d');
    let snapshotViewport = getViewport(editor);
    let pending: PendingInput | null = null;
    let literalInput = false;
    let suppressPairs = false;
    let exitOnTab = false;
    let composing = false;
    let compositionBefore: EditorSnapshot | null = null;
    let compositionViewport: EditorViewport | null = null;
    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
    let writing = false;
    let publishedText = text;
    const completionController = createEditorCompletionController({
      editor: activeEditor,
      completionEnabledRef,
      completionRef,
      setCompletion,
      isComposing: () => composing || compositionBefore !== null,
      capture,
      finishComposition,
      measure,
      history,
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

    function publishEditorState(persistSource = true, refreshSuggestions = persistSource) {
      setText(snapshot.text);
      if (persistSource) {
        publishedText = notifyEditorSourceChange(snapshot.text, publishedText, onSourceChange);
      }
      const next = getCursorPosition(snapshot);
      setCursor((current) => current.line === next.line && current.column === next.column ? current : next);
      if (refreshSuggestions) refreshCompletion();
    }

    function write(next: EditorSnapshot, viewport?: EditorViewport, keepVisible = true, refreshSuggestions = true) {
      const targetViewport = viewport ?? getViewport(editor!);
      writing = true;
      snapshot = next;
      if (editor!.value !== next.text) editor!.value = next.text;
      editor!.setSelectionRange(next.selection.start, next.selection.end, next.selection.direction);
      editor!.scrollTop = targetViewport.scrollTop;
      editor!.scrollLeft = targetViewport.scrollLeft;
      if (keepVisible) keepCaretVisible(editor!, next, measure);
      snapshotViewport = getViewport(editor!);
      writing = false;
      publishEditorState(true, refreshSuggestions);
    }

    function rejectLimit(before: EditorSnapshot, viewport: EditorViewport = snapshotViewport) {
      setLimitMessage(EDITOR_LINE_LIMIT_MESSAGE);
      pending = null;
      literalInput = false;
      suppressPairs = false;
      write(before, viewport, false);
    }

    function capture() {
      if (writing) return snapshot;
      const selection = getSelection(editor!);
      const currentText = normalizeEditorText(editor!.value);
      if (currentText !== snapshot.text) {
        const evaluation = evaluateNativeEdit(snapshot, currentText, selection);
        if (!compositionBefore && evaluation.status === 'line-limit') {
          rejectLimit(snapshot);
          return snapshot;
        }
        const next = evaluation.snapshot;
        if (!compositionBefore) {
          history.record(snapshot, next);
          setLimitMessage(null);
        }
        snapshot = next;
      } else if (!sameSelection(snapshot.selection, selection)) {
        history.breakGroup();
        snapshot = { ...snapshot, selection };
      }
      snapshotViewport = getViewport(editor!);
      if (!compositionBefore || isEditorTextWithinLineLimit(snapshot.text)) {
        publishEditorState(!compositionBefore);
      }
      return snapshot;
    }

    function finishComposition(force = false) {
      if (compositionTimer !== undefined) clearTimeout(compositionTimer);
      compositionTimer = undefined;
      if (!compositionBefore || (composing && !force)) return;
      composing = false;
      capture();
      const evaluation = evaluateNativeEdit(compositionBefore, snapshot.text, snapshot.selection);
      if (evaluation.status === 'line-limit') {
        rejectLimit(compositionBefore, compositionViewport ?? snapshotViewport);
      } else {
        snapshot = evaluation.snapshot;
        history.record(compositionBefore, snapshot);
        setLimitMessage(null);
      }
      compositionBefore = null;
      compositionViewport = null;
      pending = null;
      literalInput = false;
      suppressPairs = false;
      setIsComposing(false);
      publishEditorState();
      callbacks.onCompositionChange?.(false);
    }

    function perform(command: EditorCommand) {
      finishComposition();
      const before = capture();
      const evaluation = evaluateEditorCommand(before, command);
      if (evaluation.status === 'line-limit') {
        rejectLimit(before);
        return false;
      }
      if (evaluation.status === 'unsupported') return false;
      const result = evaluation.snapshot;
      pending = null;
      literalInput = false;
      history.record(before, result);
      setLimitMessage(null);
      write(result);
      return true;
    }

    function restore(direction: 'undo' | 'redo', before = snapshot) {
      finishComposition();
      const result = history[direction](before);
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
      finishComposition();
      const before = capture();
      const altGraph = event.getModifierState('AltGraph');
      const modified = !altGraph && (event.ctrlKey || event.metaKey || event.altKey);
      suppressPairs = modified;
      const mayExit = exitOnTab;
      exitOnTab = false;

      const manualCompletion = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && (event.code === 'Space' || event.key === ' ');
      if (manualCompletion) {
        event.preventDefault();
        history.breakGroup();
        refreshCompletion('manual');
        return;
      }

      const activeCompletion = completionRef.current;
      const completionAction = getCompletionKeyAction(
        event.key,
        activeCompletion !== null,
        activeCompletion?.selectedByUser ?? false,
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
        history.breakGroup();
        dismissCompletion(true);
        return;
      }
      if (completionAction === 'accept' && activeCompletion) {
        event.preventDefault();
        history.breakGroup();
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
        history.breakGroup();
        exitOnTab = true;
        return;
      }
      if (event.key === 'Tab' && !modified) {
        history.breakGroup();
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
      pending = { before, viewport: snapshotViewport, literal: false };
    }

    function onBeforeInput(event: Event) {
      const input = event as InputEvent;
      if (input.isComposing || composing || compositionBefore) return;
      const before = capture();
      if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') {
        if (event.cancelable) {
          event.preventDefault();
          restore(input.inputType === 'historyUndo' ? 'undo' : 'redo', before);
        } else {
          pending = { before, viewport: snapshotViewport, literal: true };
        }
        return;
      }

      const literal = literalInput || (input.inputType !== 'insertText'
        && input.inputType !== 'deleteContentBackward'
        && input.inputType !== 'deleteContentForward'
        && input.inputType !== 'insertLineBreak' && input.inputType !== 'insertParagraph');
      const command = literal || suppressPairs ? undefined : inputCommand(input);
      const evaluation = command ? evaluateEditorCommand(before, command) : undefined;
      if (evaluation?.status === 'line-limit') {
        if (event.cancelable) {
          event.preventDefault();
          rejectLimit(before, snapshotViewport);
        } else {
          pending = { before, viewport: snapshotViewport, literal: true };
        }
        return;
      }
      const result = evaluation?.status === 'applied' ? evaluation.snapshot : null;
      if (result && event.cancelable) {
        event.preventDefault();
        history.record(before, result);
        pending = null;
        literalInput = false;
        suppressPairs = false;
        setLimitMessage(null);
        write(result);
      } else {
        pending = { before, viewport: snapshotViewport, literal, command, evaluation };
      }
    }

    function onInput(event: Event) {
      const input = event as InputEvent;
      if (composing || input.isComposing || compositionBefore) {
        snapshot = reconcileNativeEdit(snapshot, editor!.value, getSelection(editor!));
        snapshotViewport = getViewport(editor!);
        pending = null;
        if (isEditorTextWithinLineLimit(snapshot.text)) publishEditorState(false);
        return;
      }
      const before = pending?.before ?? snapshot;
      const viewport = pending?.viewport ?? snapshotViewport;
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
        ? pending?.evaluation ?? evaluateEditorCommand(before, command)
        : undefined;
      const result = evaluation?.status === 'applied' ? evaluation.snapshot : undefined;
      if (result && command && nativeNext.text === expectedNativeText(before, command)) {
        history.record(before, result);
        setLimitMessage(null);
        write(result);
      } else {
        const kind = !literal && input.inputType === 'insertText' && input.data?.length === 1
          ? 'typing' : !literal && (input.inputType === 'deleteContentBackward'
            || input.inputType === 'deleteContentForward') ? 'delete' : 'action';
        history.record(before, nativeNext, { kind });
        setLimitMessage(null);
        snapshot = nativeNext;
        snapshotViewport = getViewport(editor!);
        publishEditorState();
      }
      pending = null;
      literalInput = false;
      suppressPairs = false;
    }

    function onLiteralEdit() {
      if (composing) return;
      finishComposition();
      history.breakGroup();
      const before = capture();
      pending = { before, viewport: snapshotViewport, literal: true };
      literalInput = true;
      suppressPairs = false;
    }

    function onCompositionStart() {
      finishComposition();
      dismissCompletion();
      composing = true;
      compositionBefore = capture();
      compositionViewport = snapshotViewport;
      setIsComposing(true);
      callbacks.onCompositionChange?.(true);
      exitOnTab = false;
      pending = null;
      history.breakGroup();
    }

    function onCompositionEnd() {
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
      history.breakGroup();
      dismissCompletion();
      finishComposition(true);
      pending = null;
      suppressPairs = false;
    }

    editor.addEventListener('keydown', onKeyDown);
    editor.addEventListener('keyup', onKeyUp);
    editor.addEventListener('beforeinput', onBeforeInput);
    editor.addEventListener('input', onInput);
    editor.addEventListener('select', onSelectionChange);
    editor.addEventListener('click', onSelectionChange);
    editor.addEventListener('paste', onLiteralEdit);
    editor.addEventListener('cut', onLiteralEdit);
    editor.addEventListener('drop', onLiteralEdit);
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
      editor.removeEventListener('paste', onLiteralEdit);
      editor.removeEventListener('cut', onLiteralEdit);
      editor.removeEventListener('drop', onLiteralEdit);
      editor.removeEventListener('compositionstart', onCompositionStart);
      editor.removeEventListener('compositionend', onCompositionEnd);
      editor.removeEventListener('blur', onBlur);
      document.removeEventListener('selectionchange', onSelectionChange);
      completionRefreshRef.current = () => {};
      completionAcceptRef.current = () => false;
      completionDismissRef.current = () => {};
    };
  }, []);

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
    cursor,
    text,
    limitMessage,
    isComposing,
    completion: completionEnabled ? completion : null,
    acceptCompletion,
    dismissCompletion: dismissCompletionFromViewport,
  };
}
