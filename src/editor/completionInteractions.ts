export type CompletionKeyAction = 'accept' | 'dismiss' | 'move-next' | 'move-previous' | 'pass-through';

export function getCompletionKeyAction(
  key: string,
  menuOpen: boolean,
  selectedByUser: boolean,
  modified: boolean,
  shiftKey: boolean,
): CompletionKeyAction {
  if (!menuOpen || modified) return 'pass-through';
  if (shiftKey && (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Enter')) {
    return 'pass-through';
  }
  if (key === 'ArrowDown') return 'move-next';
  if (key === 'ArrowUp') return 'move-previous';
  if (key === 'Escape') return 'dismiss';
  if (key === 'Tab' && !shiftKey) return 'accept';
  if (key === 'Enter' && selectedByUser) return 'accept';
  return 'pass-through';
}

export function canCalculateCompletion(
  enabled: boolean,
  composing: boolean,
  hasSelection: boolean,
  editorFocused: boolean,
): boolean {
  return enabled && !composing && !hasSelection && editorFocused;
}

export function isCompletionCaretVisible(
  caret: { readonly left: number; readonly top: number; readonly lineHeight: number },
  viewport: {
    readonly scrollTop: number;
    readonly scrollLeft: number;
    readonly clientHeight: number;
    readonly clientWidth: number;
  },
): boolean {
  const caretVerticalAnchor = caret.top + caret.lineHeight / 2;
  return caretVerticalAnchor >= viewport.scrollTop
    && caretVerticalAnchor < viewport.scrollTop + viewport.clientHeight
    && caret.left >= viewport.scrollLeft
    && caret.left + 1 <= viewport.scrollLeft + viewport.clientWidth;
}

export function isEditorCompositionEvent(
  event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>,
  composing: boolean,
): boolean {
  return event.isComposing || composing || event.keyCode === 229;
}
