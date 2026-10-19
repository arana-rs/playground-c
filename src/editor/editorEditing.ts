import { getEditorCaretGeometry } from './caretGeometry.ts';
import type { EditorCommand, EditorSelection, EditorSnapshot } from './types.ts';

export interface EditorViewport {
  scrollTop: number;
  scrollLeft: number;
}

export function getSelection(editor: HTMLTextAreaElement): EditorSelection {
  return {
    start: editor.selectionStart,
    end: editor.selectionEnd,
    direction: editor.selectionDirection === 'backward' ? 'backward'
      : editor.selectionDirection === 'forward' ? 'forward' : 'none',
  };
}

export function sameSelection(a: EditorSelection, b: EditorSelection): boolean {
  return a.start === b.start && a.end === b.end && a.direction === b.direction;
}

export function getViewport(editor: HTMLTextAreaElement): EditorViewport {
  return { scrollTop: editor.scrollTop, scrollLeft: editor.scrollLeft };
}

export function inputCommand(input: InputEvent): EditorCommand | undefined {
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
export function expectedNativeText(before: EditorSnapshot, command: EditorCommand): string | null {
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

export function keepCaretVisible(editor: HTMLTextAreaElement, snapshot: EditorSnapshot,
  measure: CanvasRenderingContext2D | null): void {
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
