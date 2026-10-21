import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { EditorCompletionState } from './useCodeEditor.ts';
import type { EditorLanguage } from './languageMode.ts';

interface CodeEditorInputProps {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  className: string;
  accessibleLabel: string;
  initialText: string;
  language: EditorLanguage;
  readOnly: boolean;
  completion: EditorCompletionState | null;
  completionPopoverId: string;
  onPointerMove: (event: ReactPointerEvent<HTMLTextAreaElement>) => void;
  onPointerLeave: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onInput: () => void;
  onSelect: () => void;
}

export function CodeEditorInput({
  editorRef,
  className,
  accessibleLabel,
  initialText,
  language,
  readOnly,
  completion,
  completionPopoverId,
  onPointerMove,
  onPointerLeave,
  onCompositionStart,
  onCompositionEnd,
  onInput,
  onSelect,
}: CodeEditorInputProps) {
  return (
    <textarea
      ref={editorRef}
      className={className}
      data-editor-language={language}
      aria-label={accessibleLabel}
      aria-autocomplete={completion ? 'list' : 'none'}
      aria-controls={completion ? completionPopoverId : undefined}
      aria-activedescendant={completion
        ? `${completionPopoverId}-option-${completion.selectedIndex}` : undefined}
      defaultValue={initialText}
      readOnly={readOnly}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      wrap="off"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onInput={onInput}
      onSelect={onSelect}
    />
  );
}
