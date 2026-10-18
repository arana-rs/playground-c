import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { getEditorLineCount, MAX_EDITOR_LINES } from './limits.ts';
import type { EditorLimitMessage } from './limits.ts';
import { highlightC } from './highlight.ts';
import { useI18n } from '../i18n.tsx';

interface CodeEditorProps {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  initialText?: string;
  activeLine?: number;
  highlightLine?: number;
  readOnly?: boolean;
  showActiveLine?: boolean;
  compactReadOnlyGutter?: boolean;
  limitMessage?: EditorLimitMessage | null;
}

const EditorLineNumber = memo(function EditorLineNumber({
  line, current,
}: {
  line: number;
  current: boolean;
}) {
  return (
    <span className={current ? 'editor-line-number is-current' : 'editor-line-number'}>
      {line}
    </span>
  );
});

export const CodeEditor = memo(function CodeEditor({
  editorRef, text, initialText = '', activeLine = 1, highlightLine,
  readOnly = false, showActiveLine = true, compactReadOnlyGutter = false,
  limitMessage = null,
}: CodeEditorProps) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const executionLineRef = useRef<HTMLDivElement>(null);
  const gutterViewportRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const tokens = useMemo(() => highlightC(text), [text]);
  const tokenSpans = useMemo(() => tokens.map(token => (
    <span key={token.start} className={'syntax-' + token.kind}>
      {text.slice(token.start, token.end)}
    </span>
  )), [text, tokens]);
  const lineCount = useMemo(
    () => Math.min(getEditorLineCount(text), MAX_EDITOR_LINES),
    [text],
  );
  const useCompactReadOnlyGutter = readOnly && compactReadOnlyGutter;
  const compactGutterClass = useCompactReadOnlyGutter
    ? ` is-compact-readonly-gutter${lineCount >= 100 ? ' has-three-digit-line-numbers' : ''}`
    : '';
  const visibleLine = Math.max(1, Math.min(MAX_EDITOR_LINES, activeLine));
  const lineNumberSpans = useMemo(() => Array.from({ length: lineCount }, (_, index) => {
    const line = index + 1;
    return <EditorLineNumber key={line} line={line} current={showActiveLine && line === visibleLine} />;
  }), [lineCount, showActiveLine, visibleLine]);

  const syncScroll = useCallback(() => {
    const editor = editorRef.current;
    const viewport = viewportRef.current;
    const highlight = highlightRef.current;
    const executionLine = executionLineRef.current;
    const gutterViewport = gutterViewportRef.current;
    const gutter = gutterRef.current;
    if (!editor || !viewport || !highlight || !gutterViewport || !gutter) return;
    // The textarea remains the sole scroller; the code layer follows both axes
    // while the gutter follows only the line position.
    viewport.style.width = String(editor.clientWidth) + 'px';
    viewport.style.height = String(editor.clientHeight) + 'px';
    gutterViewport.style.height = String(editor.clientHeight) + 'px';
    highlight.style.transform = 'translate(' + (-editor.scrollLeft) + 'px, '
      + (-editor.scrollTop) + 'px)';
    if (executionLine) {
      executionLine.style.transform = 'translateY(' + (-editor.scrollTop) + 'px)';
    }
    gutter.style.transform = 'translateY(' + (-editor.scrollTop) + 'px)';
  }, [editorRef]);

  const keepExecutionLineVisible = useCallback(() => {
    const editor = editorRef.current;
    if (!readOnly || !editor || !highlightLine || highlightLine < 1) return;
    const style = getComputedStyle(editor);
    const lineHeight = parseFloat(style.lineHeight) || 21;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const lineTop = paddingTop + (Math.min(MAX_EDITOR_LINES, highlightLine) - 1) * lineHeight;
    const lineBottom = lineTop + lineHeight;
    const visibleTop = editor.scrollTop + paddingTop;
    const visibleBottom = editor.scrollTop + editor.clientHeight - paddingBottom;

    if (lineTop < visibleTop) editor.scrollTop = Math.max(0, lineTop - paddingTop);
    else if (lineBottom > visibleBottom) {
      editor.scrollTop = Math.max(0, lineBottom - editor.clientHeight + paddingBottom);
    }
  }, [editorRef, highlightLine, readOnly]);

  const syncAfterResize = useCallback(() => {
    keepExecutionLineVisible();
    syncScroll();
  }, [keepExecutionLineVisible, syncScroll]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.addEventListener('scroll', syncScroll, { passive: true });
    const observer = new ResizeObserver(syncAfterResize);
    observer.observe(editor);
    syncScroll();
    return () => { editor.removeEventListener('scroll', syncScroll); observer.disconnect(); };
  }, [editorRef, syncAfterResize, syncScroll]);
  useLayoutEffect(syncScroll, [text, highlightLine, syncScroll]);

  useLayoutEffect(() => {
    keepExecutionLineVisible();
    syncScroll();
  }, [keepExecutionLineVisible, syncScroll]);

  return (
    <>
      <div ref={viewportRef} className="editor-highlight-viewport" aria-hidden="true">
        {readOnly && highlightLine !== undefined && highlightLine >= 1 && highlightLine <= lineCount && (
          <div
            ref={executionLineRef}
            className="editor-execution-line"
            style={{ top: `${8 + (highlightLine - 1) * 21}px` }}
          />
        )}
        <pre ref={highlightRef} className={`editor-highlight${compactGutterClass}`}>
          {tokenSpans}
          <span className="editor-line-end">{'\u200b'}</span>
        </pre>
      </div>
      <textarea
        ref={editorRef}
        className={`editor${readOnly ? ' is-readonly' : ''}${compactGutterClass}`}
        aria-label={t('editor.codeAreaLabel', { file: 'main.c' })}
        defaultValue={initialText}
        readOnly={readOnly}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        wrap="off"
      />
      <div ref={gutterViewportRef} className={`editor-gutter-viewport${compactGutterClass}`} aria-hidden="true">
        <div ref={gutterRef} className="editor-gutter">
          <div className="editor-line-numbers">
            {lineNumberSpans}
          </div>
          {!useCompactReadOnlyGutter && <div className="editor-diagnostic-space" />}
        </div>
      </div>
      <div
        className={limitMessage ? 'editor-limit-status is-visible' : 'editor-limit-status'}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {limitMessage?.kind === 'line-limit'
          ? t('editor.lineLimit', { max: MAX_EDITOR_LINES })
          : limitMessage?.kind === 'file-too-long'
            ? t('editor.fileTooLong', { count: limitMessage.lineCount, max: MAX_EDITOR_LINES })
            : ''}
      </div>
    </>
  );
});
