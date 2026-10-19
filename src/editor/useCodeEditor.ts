import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createEditorHistory } from './history.ts';
import { getEditorCaretGeometry } from './caretGeometry.ts';
import {
  evaluateEditorCommand,
  evaluateEditorTextReplacement,
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
import type { EditorCommand, EditorSelection, EditorSnapshot } from './types.ts';
import type { EditorCommandEvaluation } from './operations.ts';
import { getCompletionSuggestions } from './completionProvider.ts';
import type { CompletionTrigger } from './completionProvider.ts';
import {
  canCalculateCompletion,
  getCompletionKeyAction,
  isCompletionCaretVisible,
  isEditorCompositionEvent,
} from './completionInteractions.ts';

interface EditorViewport {
  scrollTop: number;
  scrollLeft: number;
}

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

export interface EditorCompletionState {
  readonly cursorOffset: number;
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly options: readonly string[];
  readonly selectedIndex: number;
  readonly selectedByUser: boolean;
}

interface ActiveEditorCompletion extends EditorCompletionState {
  readonly contextKey: string;
  readonly manual: boolean;
}

function getSelection(editor: HTMLTextAreaElement): EditorSelection {
  return {
    start: editor.selectionStart,
    end: editor.selectionEnd,
    direction: editor.selectionDirection === 'backward' ? 'backward'
      : editor.selectionDirection === 'forward' ? 'forward' : 'none',
  };
}

function sameSelection(a: EditorSelection, b: EditorSelection) {
  return a.start === b.start && a.end === b.end && a.direction === b.direction;
}

function getViewport(editor: HTMLTextAreaElement): EditorViewport {
  return { scrollTop: editor.scrollTop, scrollLeft: editor.scrollLeft };
}

function inputCommand(input: InputEvent): EditorCommand | undefined {
  if (input.inputType === 'insertText' && input.data?.length === 1) {
    return { type: 'type', character: input.data };
  }
  if (input.inputType === 'insertLineBreak' || input.inputType === 'insertParagraph') {
    return { type: 'enter' };
  }
  if (input.inputType === 'deleteContentBackward') return { type: 'backspace' };
  return undefined;
}

/** Check the browser edit before replacing it with a command in input fallback. */
function expectedNativeText(before: EditorSnapshot, command: EditorCommand): string | null {
  const { text, selection: { start, end } } = before;
  if (command.type === 'type') {
    return text.slice(0, start) + command.character + text.slice(end);
  }
  if (command.type === 'enter') return text.slice(0, start) + '\n' + text.slice(end);
  if (command.type === 'backspace') {
    return text.slice(0, start === end ? Math.max(0, start - 1) : start) + text.slice(end);
  }
  return null;
}

function keepCaretVisible(editor: HTMLTextAreaElement, snapshot: EditorSnapshot,
  measure: CanvasRenderingContext2D | null) {
  const style = getComputedStyle(editor);
  const bottom = parseFloat(style.paddingBottom) || 0;
  const left = parseFloat(style.paddingLeft) || 0;
  const right = parseFloat(style.paddingRight) || 0;
  const offset = snapshot.selection.direction === 'backward'
    ? snapshot.selection.start : snapshot.selection.end;
  const caret = getEditorCaretGeometry(editor, snapshot.text, offset, measure);
  const lineTop = caret.top;
  const top = parseFloat(style.paddingTop) || 0;

  if (lineTop < editor.scrollTop + top) editor.scrollTop = Math.max(0, lineTop - top);
  else if (lineTop + caret.lineHeight > editor.scrollTop + editor.clientHeight - bottom) {
    editor.scrollTop = lineTop + caret.lineHeight - editor.clientHeight + bottom;
  }

  const caretLeft = caret.left;
  if (caretLeft < editor.scrollLeft + left) editor.scrollLeft = Math.max(0, caretLeft - left);
  else if (caretLeft + 1 > editor.scrollLeft + editor.clientWidth - right) {
    editor.scrollLeft = caretLeft + 1 - editor.clientWidth + right;
  }
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
    let dismissedCompletionContext: string | null = null;

    function completionContextKey(source: string, cursorOffset: number): string {
      return `${cursorOffset}\u0000${source}`;
    }

    function updateCompletion(next: ActiveEditorCompletion | null) {
      completionRef.current = next;
      setCompletion(next);
    }

    function refreshCompletion(trigger: CompletionTrigger = 'automatic') {
      if (!editor) {
        updateCompletion(null);
        return;
      }
      const selection = getSelection(editor);
      if (!canCalculateCompletion(
        completionEnabledRef.current,
        composing || compositionBefore !== null,
        selection.start !== selection.end,
        document.activeElement === editor,
      )) {
        updateCompletion(null);
        return;
      }
      const source = normalizeEditorText(editor.value);
      const cursorOffset = selection.end;
      const contextKey = completionContextKey(source, cursorOffset);
      if (trigger === 'automatic' && dismissedCompletionContext === contextKey) {
        updateCompletion(null);
        return;
      }
      if (dismissedCompletionContext !== contextKey) dismissedCompletionContext = null;

      const previous = completionRef.current;
      const effectiveTrigger = trigger === 'automatic' && previous?.contextKey === contextKey && previous.manual
        ? 'manual' : trigger;
      const result = getCompletionSuggestions({ source, cursorOffset, trigger: effectiveTrigger });
      if (!result) {
        updateCompletion(null);
        return;
      }
      const sameContext = previous?.contextKey === contextKey
        && previous.replaceStart === result.replaceStart
        && previous.replaceEnd === result.replaceEnd
        && previous.options.length === result.options.length
        && previous.options.every((option, index) => option === result.options[index]);
      updateCompletion({
        cursorOffset,
        ...result,
        selectedIndex: sameContext ? previous.selectedIndex : 0,
        selectedByUser: sameContext && previous.selectedByUser,
        contextKey,
        manual: effectiveTrigger === 'manual',
      });
    }

    completionRefreshRef.current = refreshCompletion;

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

    function dismissCompletion(suppressAutomatic = false) {
      if (suppressAutomatic && editor) {
        const selection = getSelection(editor);
        if (selection.start === selection.end) {
          dismissedCompletionContext = completionContextKey(
            normalizeEditorText(editor.value), selection.end,
          );
        }
      }
      updateCompletion(null);
    }

    completionDismissRef.current = () => dismissCompletion(true);

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

    function acceptCompletionAt(index: number): boolean {
      if (!completionEnabledRef.current) {
        dismissCompletion();
        return false;
      }
      finishComposition();
      const before = capture();
      const current = completionRef.current;
      if (!current || !Number.isInteger(index) || index < 0 || index >= current.options.length) return false;
      const caret = getEditorCaretGeometry(activeEditor, before.text, current.cursorOffset, measure);
      if (!isCompletionCaretVisible(caret, {
        scrollTop: activeEditor.scrollTop,
        scrollLeft: activeEditor.scrollLeft,
        clientHeight: activeEditor.clientHeight,
        clientWidth: activeEditor.clientWidth,
      })) {
        dismissCompletion(true);
        return false;
      }
      const replacement = current.options[index];
      const evaluation = evaluateEditorTextReplacement(
        before,
        current.replaceStart,
        current.replaceEnd,
        replacement,
      );
      if (!evaluation || evaluation.status === 'line-limit') {
        dismissCompletion();
        return false;
      }
      history.breakGroup();
      history.record(before, evaluation.snapshot);
      const nextOffset = current.replaceStart + replacement.length;
      dismissedCompletionContext = completionContextKey(evaluation.snapshot.text, nextOffset);
      pending = null;
      literalInput = false;
      suppressPairs = false;
      setLimitMessage(null);
      dismissCompletion();
      write(evaluation.snapshot, undefined, true, false);
      return true;
    }

    completionAcceptRef.current = acceptCompletionAt;

    function moveCompletionSelection(direction: -1 | 1): boolean {
      const current = completionRef.current;
      if (!current || current.options.length === 0) return false;
      const selectedIndex = (current.selectedIndex + direction + current.options.length) % current.options.length;
      updateCompletion({ ...current, selectedIndex, selectedByUser: true });
      return true;
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
