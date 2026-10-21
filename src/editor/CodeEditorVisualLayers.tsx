import { memo, useMemo } from 'react';
import type { RefObject } from 'react';
import { MAX_EDITOR_LINES } from './limits.ts';
import { highlightC } from './highlight.ts';
import type { EditorLanguage } from './languageMode.ts';
import { splitHighlightTokensAtDiagnostics } from './diagnosticRendering.ts';
import type { EditorDiagnosticAnchorRange } from './editorDiagnosticAnchors.ts';

interface EditorLineNumberProps {
  line: number;
  current: boolean;
}

const EditorLineNumber = memo(function EditorLineNumber({ line, current }: EditorLineNumberProps) {
  return (
    <span className={current ? 'editor-line-number is-current' : 'editor-line-number'}>
      {line}
    </span>
  );
});

interface CodeEditorHighlightLayerProps {
  text: string;
  lineCount: number;
  readOnly: boolean;
  language: EditorLanguage;
  highlightLine?: number;
  compactGutterClass: string;
  diagnosticAnchorRanges: readonly EditorDiagnosticAnchorRange[];
  viewportRef: RefObject<HTMLDivElement | null>;
  highlightRef: RefObject<HTMLPreElement | null>;
  executionLineRef: RefObject<HTMLDivElement | null>;
}

export const CodeEditorHighlightLayer = memo(function CodeEditorHighlightLayer({
  text,
  lineCount,
  readOnly,
  language,
  highlightLine,
  compactGutterClass,
  diagnosticAnchorRanges,
  viewportRef,
  highlightRef,
  executionLineRef,
}: CodeEditorHighlightLayerProps) {
  const tokens = useMemo(() => language === 'c'
    ? highlightC(text)
    : [{ start: 0, end: text.length, kind: 'plain' as const }], [language, text]);
  const tokenSpans = useMemo(() => splitHighlightTokensAtDiagnostics(
    text,
    tokens,
    diagnosticAnchorRanges,
  ).map(segment => (
    <span
      key={segment.start}
      className={`syntax-${segment.kind}${segment.diagnostic
        ? segment.related
          ? ' editor-diagnostic-mark editor-diagnostic-related-anchor'
          : ' editor-diagnostic-mark editor-diagnostic-anchor'
        : ''}`}
      data-diagnostic-line={segment.diagnosticLine}
      data-diagnostic-offset={segment.diagnostic ? segment.start : undefined}
    >
      {text.slice(segment.start, segment.end)}
    </span>
  )), [diagnosticAnchorRanges, text, tokens]);

  return (
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
  );
});

interface CodeEditorGutterLayerProps {
  lineCount: number;
  activeLine: number;
  showActiveLine: boolean;
  compactGutterClass: string;
  useCompactReadOnlyGutter: boolean;
  gutterViewportRef: RefObject<HTMLDivElement | null>;
  gutterRef: RefObject<HTMLDivElement | null>;
}

export const CodeEditorGutterLayer = memo(function CodeEditorGutterLayer({
  lineCount,
  activeLine,
  showActiveLine,
  compactGutterClass,
  useCompactReadOnlyGutter,
  gutterViewportRef,
  gutterRef,
}: CodeEditorGutterLayerProps) {
  const visibleLine = Math.max(1, Math.min(MAX_EDITOR_LINES, activeLine));
  const lineNumberSpans = useMemo(() => Array.from({ length: lineCount }, (_, index) => {
    const line = index + 1;
    return <EditorLineNumber key={line} line={line} current={showActiveLine && line === visibleLine} />;
  }), [lineCount, showActiveLine, visibleLine]);

  return (
    <div ref={gutterViewportRef} className={`editor-gutter-viewport${compactGutterClass}`} aria-hidden="true">
      <div ref={gutterRef} className="editor-gutter">
        <div className="editor-line-numbers" aria-hidden="true">
          {lineNumberSpans}
        </div>
        {!useCompactReadOnlyGutter && <div className="editor-diagnostic-space" aria-hidden="true" />}
      </div>
    </div>
  );
});
