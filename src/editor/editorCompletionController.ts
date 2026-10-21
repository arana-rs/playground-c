import { getEditorCaretGeometry } from './caretGeometry.ts';
import { canCalculateCompletion, isCompletionCaretVisible } from './completionInteractions.ts';
import { getCompletionSuggestions } from './completionProvider.ts';
import type { CompletionTrigger } from './completionProvider.ts';
import { evaluateEditorTextReplacement } from './operations.ts';
import { getSelection, type EditorViewport } from './editorEditing.ts';
import type { EditorSnapshot } from './types.ts';
import { normalizeEditorText } from './limits.ts';
import type { EditorLimitMessage } from './limits.ts';
import type { createEditorHistory } from './history.ts';

export interface EditorCompletionState {
  readonly cursorOffset: number;
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly options: readonly string[];
  readonly selectedIndex: number;
}

export interface ActiveEditorCompletion extends EditorCompletionState {
  readonly contextKey: string;
  readonly manual: boolean;
}

interface EditorCompletionOptions {
  editor: HTMLTextAreaElement;
  completionEnabledRef: { current: boolean };
  completionRef: { current: ActiveEditorCompletion | null };
  setCompletion: (completion: EditorCompletionState | null) => void;
  isReadOnly: () => boolean;
  isComposing: () => boolean;
  capture: () => EditorSnapshot;
  finishComposition: () => void;
  measure: CanvasRenderingContext2D | null;
  getHistory: () => ReturnType<typeof createEditorHistory>;
  resetPendingInput: () => void;
  setLimitMessage: (message: EditorLimitMessage | null) => void;
  write: (next: EditorSnapshot, viewport?: EditorViewport, keepVisible?: boolean,
    refreshSuggestions?: boolean) => void;
}

function completionContextKey(source: string, cursorOffset: number): string {
  return `${cursorOffset}\u0000${source}`;
}

/** Owns suggestion visibility and acceptance for one textarea lifecycle. */
export function createEditorCompletionController({
  editor,
  completionEnabledRef,
  completionRef,
  setCompletion,
  isReadOnly,
  isComposing,
  capture,
  finishComposition,
  measure,
  getHistory,
  resetPendingInput,
  setLimitMessage,
  write,
}: EditorCompletionOptions) {
  let dismissedCompletionContext: string | null = null;

  function updateCompletion(next: ActiveEditorCompletion | null): void {
    completionRef.current = next;
    setCompletion(next);
  }

  function refreshCompletion(trigger: CompletionTrigger = 'automatic'): void {
    const selection = getSelection(editor);
    if (!canCalculateCompletion(
      completionEnabledRef.current,
      isComposing(),
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
      contextKey,
      manual: effectiveTrigger === 'manual',
    });
  }

  function dismissCompletion(suppressAutomatic = false): void {
    if (suppressAutomatic) {
      const selection = getSelection(editor);
      if (selection.start === selection.end) {
        dismissedCompletionContext = completionContextKey(
          normalizeEditorText(editor.value), selection.end,
        );
      }
    }
    updateCompletion(null);
  }

  function acceptCompletionAt(index: number): boolean {
    if (isReadOnly() || !completionEnabledRef.current) {
      dismissCompletion();
      return false;
    }
    finishComposition();
    const before = capture();
    const current = completionRef.current;
    if (!current || !Number.isInteger(index) || index < 0 || index >= current.options.length) return false;
    const caret = getEditorCaretGeometry(editor, before.text, current.cursorOffset, measure);
    if (!isCompletionCaretVisible(caret, {
      scrollTop: editor.scrollTop,
      scrollLeft: editor.scrollLeft,
      clientHeight: editor.clientHeight,
      clientWidth: editor.clientWidth,
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
    const history = getHistory();
    history.breakGroup();
    history.record(before, evaluation.snapshot);
    const nextOffset = current.replaceStart + replacement.length;
    dismissedCompletionContext = completionContextKey(evaluation.snapshot.text, nextOffset);
    resetPendingInput();
    setLimitMessage(null);
    dismissCompletion();
    write(evaluation.snapshot, undefined, true, false);
    return true;
  }

  function moveCompletionSelection(direction: -1 | 1): boolean {
    const current = completionRef.current;
    if (!current || current.options.length === 0) return false;
    const selectedIndex = (current.selectedIndex + direction + current.options.length) % current.options.length;
    updateCompletion({ ...current, selectedIndex });
    return true;
  }

  return { refreshCompletion, dismissCompletion, acceptCompletionAt, moveCompletionSelection };
}
