import { useCallback, useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';
import type { EditorCompletionState } from './useCodeEditor.ts';
import { getEditorCaretGeometry } from './caretGeometry.ts';
import { isCompletionCaretVisible } from './completionInteractions.ts';
import { useI18n } from '../i18n.tsx';

interface CodeEditorCompletionOverlayOptions {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  completion: EditorCompletionState | null;
  onCompletionAccept?: (index: number) => boolean;
  onCompletionDismiss?: () => void;
}

export function useCodeEditorCompletionOverlay({
  editorRef,
  completion,
  onCompletionAccept,
  onCompletionDismiss,
}: CodeEditorCompletionOverlayOptions) {
  const { t } = useI18n();
  const popoverId = useId();
  const popoverRef = useRef<HTMLDivElement>(null);
  const completionRef = useRef(completion);
  const caretMeasureRef = useRef<CanvasRenderingContext2D | null>(null);
  completionRef.current = completion;

  const positionPopover = useCallback(() => {
    const editor = editorRef.current;
    const popover = popoverRef.current;
    const completionState = completionRef.current;
    const pane = editor?.parentElement;
    if (!editor || !popover || !completionState || !pane) return;

    if (!caretMeasureRef.current) caretMeasureRef.current = document.createElement('canvas').getContext('2d');
    const caret = getEditorCaretGeometry(
      editor,
      editor.value,
      completionState.cursorOffset,
      caretMeasureRef.current,
    );
    const editorRect = editor.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const requestedLeft = editorRect.left - paneRect.left + editor.clientLeft
      + caret.left - editor.scrollLeft;
    const requestedTop = editorRect.top - paneRect.top + editor.clientTop
      + caret.top + caret.lineHeight - editor.scrollTop;
    const maxLeft = Math.max(4, pane.clientWidth - popover.offsetWidth - 4);
    const maxTop = Math.max(4, pane.clientHeight - popover.offsetHeight - 4);
    popover.style.left = `${Math.max(4, Math.min(requestedLeft, maxLeft))}px`;
    popover.style.top = `${Math.max(4, Math.min(requestedTop, maxTop))}px`;
  }, [editorRef]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    let frame: number | null = null;
    let paddingTransitionActive = false;
    const updateWhileTransitioning = () => {
      if (!paddingTransitionActive) {
        frame = null;
        return;
      }
      positionPopover();
      frame = window.requestAnimationFrame(updateWhileTransitioning);
    };
    const onTransitionRun = (event: TransitionEvent) => {
      if (event.propertyName !== 'padding-left') return;
      paddingTransitionActive = true;
      positionPopover();
      if (frame === null) frame = window.requestAnimationFrame(updateWhileTransitioning);
    };
    const onTransitionFinish = (event: TransitionEvent) => {
      if (event.propertyName !== 'padding-left') return;
      paddingTransitionActive = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      positionPopover();
    };

    editor.addEventListener('transitionrun', onTransitionRun);
    editor.addEventListener('transitionend', onTransitionFinish);
    editor.addEventListener('transitioncancel', onTransitionFinish);
    return () => {
      paddingTransitionActive = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
      editor.removeEventListener('transitionrun', onTransitionRun);
      editor.removeEventListener('transitionend', onTransitionFinish);
      editor.removeEventListener('transitioncancel', onTransitionFinish);
    };
  }, [editorRef, positionPopover]);

  const dismissOffscreen = useCallback(() => {
    const editor = editorRef.current;
    const completionState = completionRef.current;
    if (!editor || !completionState) return;
    if (!caretMeasureRef.current) caretMeasureRef.current = document.createElement('canvas').getContext('2d');
    const caret = getEditorCaretGeometry(
      editor,
      editor.value,
      completionState.cursorOffset,
      caretMeasureRef.current,
    );
    if (!isCompletionCaretVisible(caret, {
      scrollTop: editor.scrollTop,
      scrollLeft: editor.scrollLeft,
      clientHeight: editor.clientHeight,
      clientWidth: editor.clientWidth,
    })) {
      onCompletionDismiss?.();
    }
  }, [editorRef, onCompletionDismiss]);

  const overlay = completion && (
    <div className="editor-completion-overlay" aria-hidden="false">
      <div
        ref={popoverRef}
        id={popoverId}
        className="editor-completion-popover"
        role="listbox"
        aria-label={t('editor.completionListLabel')}
      >
        {completion.options.map((option, index) => (
          <div
            key={`${option}:${index}`}
            id={`${popoverId}-option-${index}`}
            className={`editor-completion-option${completion.selectedIndex === index ? ' is-active' : ''}`}
            role="option"
            aria-selected={completion.selectedIndex === index}
            onMouseDown={event => event.preventDefault()}
            onClick={() => onCompletionAccept?.(index)}
          >
            {option}
          </div>
        ))}
      </div>
    </div>
  );

  return {
    popoverId,
    popoverRef,
    positionPopover,
    dismissOffscreen,
    overlay,
  };
}
