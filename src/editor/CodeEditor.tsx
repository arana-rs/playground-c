import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { getEditorLineCount, MAX_EDITOR_LINES } from './limits.ts';
import type { EditorLimitMessage } from './limits.ts';
import { highlightC } from './highlight.ts';
import {
  createDiagnosticAnchorHitbox,
  findDiagnosticAnchorAtPoint,
  getDiagnosticPopoverVerticalPlacement,
  splitHighlightTokensAtDiagnostics,
} from './diagnosticRendering.ts';
import type { DiagnosticAnchorHitbox } from './diagnosticRendering.ts';
import type { EditorDiagnosticGroup } from './editorDiagnostics.ts';
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
  diagnostics?: readonly EditorDiagnosticGroup[];
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

function getDiagnosticPopoverTop(
  editor: HTMLTextAreaElement,
  popover: HTMLDivElement,
  line: number,
): number {
  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || 21;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const requestedTop = paddingTop + (line - 1) * lineHeight - editor.scrollTop - 2;
  const maxTop = Math.max(4, editor.clientHeight - popover.offsetHeight - 4);
  return Math.max(4, Math.min(requestedTop, maxTop));
}

function revealEditorLine(editor: HTMLTextAreaElement, line: number): void {
  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || 21;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const lineTop = paddingTop + (line - 1) * lineHeight;
  const lineBottom = lineTop + lineHeight;
  const visibleTop = editor.scrollTop + paddingTop;
  const visibleBottom = editor.scrollTop + editor.clientHeight - paddingBottom;

  if (lineTop < visibleTop) editor.scrollTop = Math.max(0, lineTop - paddingTop);
  else if (lineBottom > visibleBottom) {
    editor.scrollTop = Math.max(0, lineBottom - editor.clientHeight + paddingBottom);
  }
}

export const CodeEditor = memo(function CodeEditor({
  editorRef, text, initialText = '', activeLine = 1, highlightLine,
  readOnly = false, showActiveLine = true, compactReadOnlyGutter = false,
  limitMessage = null, diagnostics = [],
}: CodeEditorProps) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const executionLineRef = useRef<HTMLDivElement>(null);
  const gutterViewportRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const diagnosticMarkersRef = useRef<HTMLDivElement>(null);
  const diagnosticPopoverRef = useRef<HTMLDivElement>(null);
  const activeDiagnosticLineRef = useRef<number | null>(null);
  const activeDiagnosticAnchorOffsetRef = useRef<number | null>(null);
  const diagnosticAnchorHitboxesRef = useRef<readonly DiagnosticAnchorHitbox[] | null>(null);
  const hoveredDiagnosticAnchorRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const diagnosticCloseTimerRef = useRef<number | null>(null);
  const diagnosticOverlayRef = useRef<HTMLDivElement>(null);
  const diagnosticPopoverId = useId();
  const [hoveredDiagnosticLine, setHoveredDiagnosticLine] = useState<number | null>(null);
  const [hoveredDiagnosticAnchorOffset, setHoveredDiagnosticAnchorOffset] = useState<number | null>(null);
  const [focusedDiagnosticLine, setFocusedDiagnosticLine] = useState<number | null>(null);
  const [pinnedDiagnosticLine, setPinnedDiagnosticLine] = useState<number | null>(null);
  const [dismissedDiagnosticLine, setDismissedDiagnosticLine] = useState<number | null>(null);
  const tokens = useMemo(() => highlightC(text), [text]);
  const diagnosticGroups = readOnly ? [] : diagnostics;
  const diagnosticGroupByLine = useMemo(
    () => new Map(diagnosticGroups.map(group => [group.line, group] as const)),
    [diagnosticGroups],
  );
  const candidateDiagnosticLine = pinnedDiagnosticLine ?? focusedDiagnosticLine ?? hoveredDiagnosticLine;
  const activeDiagnosticLine = candidateDiagnosticLine === dismissedDiagnosticLine
    ? null : candidateDiagnosticLine;
  const activeDiagnosticGroup = activeDiagnosticLine === null
    ? undefined : diagnosticGroupByLine.get(activeDiagnosticLine);
  const diagnosticLineStarts = useMemo(() => {
    const lineStarts = [0];
    for (let offset = 0; offset < text.length; offset++) {
      if (text[offset] === '\r') {
        if (text[offset + 1] === '\n') offset++;
        lineStarts.push(offset + 1);
      } else if (text[offset] === '\n') {
        lineStarts.push(offset + 1);
      }
    }
    return lineStarts;
  }, [text]);
  const diagnosticAnchorRanges = useMemo(() => {
    const ranges: { start: number; length: number; kind: 'primary' | 'related'; diagnosticLine: number }[] = [];
    for (const group of diagnosticGroups) {
      for (const diagnostic of group.diagnostics) {
        for (const anchor of diagnostic.anchors) {
          if (anchor.line !== group.line || anchor.line < 1 || anchor.column < 1) continue;
          const lineStart = diagnosticLineStarts[anchor.line - 1];
          const lineEnd = diagnosticLineStarts[anchor.line] ?? text.length;
          if (lineStart === undefined) continue;
          const start = lineStart + anchor.column - 1;
          if (start >= lineStart && start + anchor.length <= lineEnd) {
            ranges.push({ start, length: anchor.length, kind: 'primary', diagnosticLine: group.line });
          }
        }
        if (group.line === diagnostic.line) {
          for (const related of diagnostic.relatedLocations) {
            for (const anchor of related.anchors) {
              if (anchor.line < 1 || anchor.column < 1) continue;
              const lineStart = diagnosticLineStarts[anchor.line - 1];
              const lineEnd = diagnosticLineStarts[anchor.line] ?? text.length;
              if (lineStart === undefined) continue;
              const start = lineStart + anchor.column - 1;
              if (start >= lineStart && start + anchor.length <= lineEnd) {
                ranges.push({ start, length: anchor.length, kind: 'related', diagnosticLine: diagnostic.line });
              }
            }
          }
        }
      }
    }
    return ranges;
  }, [diagnosticGroups, diagnosticLineStarts, text]);
  const tokenSpans = useMemo(() => splitHighlightTokensAtDiagnostics(
    text,
    tokens,
    diagnosticAnchorRanges,
  ).map(segment => {
    return (
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
    );
  }), [diagnosticAnchorRanges, text, tokens]);

  const clearDiagnosticCloseTimer = useCallback(() => {
    if (diagnosticCloseTimerRef.current === null) return;
    window.clearTimeout(diagnosticCloseTimerRef.current);
    diagnosticCloseTimerRef.current = null;
  }, []);

  const scheduleDiagnosticClose = useCallback(() => {
    clearDiagnosticCloseTimer();
    diagnosticCloseTimerRef.current = window.setTimeout(() => {
      diagnosticCloseTimerRef.current = null;
      hoveredDiagnosticAnchorRef.current = null;
      setHoveredDiagnosticAnchorOffset(null);
      setHoveredDiagnosticLine(null);
    }, 300);
  }, [clearDiagnosticCloseTimer]);

  const clearHoveredDiagnosticAnchor = useCallback(() => {
    hoveredDiagnosticAnchorRef.current = null;
    activeDiagnosticAnchorOffsetRef.current = null;
    setHoveredDiagnosticAnchorOffset(null);
  }, []);

  const dismissDiagnosticPopover = useCallback(() => {
    const line = activeDiagnosticLineRef.current;
    setPinnedDiagnosticLine(null);
    setHoveredDiagnosticLine(null);
    clearHoveredDiagnosticAnchor();
    setFocusedDiagnosticLine(null);
    if (line !== null) setDismissedDiagnosticLine(line);
    clearDiagnosticCloseTimer();
  }, [clearDiagnosticCloseTimer, clearHoveredDiagnosticAnchor]);
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

  const getDiagnosticAnchorHitboxes = useCallback(() => {
    if (diagnosticAnchorHitboxesRef.current) return diagnosticAnchorHitboxesRef.current;
    const highlight = highlightRef.current;
    if (!highlight) return [];
    const hitboxes: DiagnosticAnchorHitbox[] = [];
    for (const anchor of highlight.querySelectorAll<HTMLElement>('.editor-diagnostic-mark')) {
      const line = Number(anchor.dataset.diagnosticLine);
      const offset = Number(anchor.dataset.diagnosticOffset);
      if (!Number.isSafeInteger(line) || !Number.isSafeInteger(offset)) continue;
      for (const rect of anchor.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        hitboxes.push(createDiagnosticAnchorHitbox(rect, line, offset));
      }
    }
    diagnosticAnchorHitboxesRef.current = hitboxes;
    return hitboxes;
  }, []);

  const syncScroll = useCallback(() => {
    const editor = editorRef.current;
    const viewport = viewportRef.current;
    const highlight = highlightRef.current;
    const executionLine = executionLineRef.current;
    const gutterViewport = gutterViewportRef.current;
    const gutter = gutterRef.current;
    const diagnosticMarkers = diagnosticMarkersRef.current;
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
    if (diagnosticMarkers) {
      diagnosticMarkers.style.transform = 'translateY(' + (-editor.scrollTop) + 'px)';
    }
    const activeLine = activeDiagnosticLineRef.current;
    const popover = diagnosticPopoverRef.current;
    if (activeLine !== null && popover) {
      const anchorOffset = activeDiagnosticAnchorOffsetRef.current;
      const anchor = anchorOffset === null
        ? null
        : highlight.querySelector<HTMLElement>(`[data-diagnostic-offset="${anchorOffset}"]`);
      const anchorRect = anchor?.getBoundingClientRect();
      if (anchorRect) {
        const editorRect = editor.getBoundingClientRect();
        const popoverWidth = popover.offsetWidth;
        const maxLeft = Math.max(4, editor.clientWidth - popoverWidth - 4);
        const rightPosition = anchorRect.right - editorRect.left + 8;
        const requestedLeft = rightPosition <= maxLeft
          ? rightPosition
          : anchorRect.left - editorRect.left - popoverWidth - 8;
        popover.style.removeProperty('max-height');
        const style = getComputedStyle(editor);
        const lineHeight = parseFloat(style.lineHeight) || 21;
        const lineTop = anchorRect.top - editorRect.top;
        const verticalPlacement = getDiagnosticPopoverVerticalPlacement(
          lineTop,
          lineHeight,
          editor.clientHeight,
          popover.offsetHeight,
        );
        if (verticalPlacement.maxHeight < popover.offsetHeight) {
          popover.style.maxHeight = `${verticalPlacement.maxHeight}px`;
        }
        popover.style.left = `${Math.max(4, Math.min(requestedLeft, maxLeft))}px`;
        popover.style.top = `${verticalPlacement.top}px`;
      } else {
        popover.style.removeProperty('left');
        popover.style.removeProperty('max-height');
        popover.style.top = `${getDiagnosticPopoverTop(editor, popover, activeLine)}px`;
      }
    } else if (popover) {
      popover.style.removeProperty('left');
      popover.style.removeProperty('max-height');
    }
  }, [editorRef]);

  const handleDiagnosticPointerMove = useCallback((event: ReactPointerEvent<HTMLTextAreaElement>) => {
    if (event.pointerType === 'touch' || event.buttons !== 0 || isComposingRef.current) return;
    const anchor = findDiagnosticAnchorAtPoint(
      getDiagnosticAnchorHitboxes(),
      event.clientX,
      event.clientY,
    );
    if (!anchor) {
      if (diagnosticCloseTimerRef.current === null) scheduleDiagnosticClose();
      return;
    }

    clearDiagnosticCloseTimer();
    if (hoveredDiagnosticAnchorRef.current === anchor.offset) return;
    hoveredDiagnosticAnchorRef.current = anchor.offset;
    setHoveredDiagnosticAnchorOffset(anchor.offset);
    setHoveredDiagnosticLine(anchor.line);
    setDismissedDiagnosticLine(null);
  }, [clearDiagnosticCloseTimer, getDiagnosticAnchorHitboxes, scheduleDiagnosticClose]);

  const handleEditorGeometryChange = useCallback(() => {
    diagnosticAnchorHitboxesRef.current = null;
    if (hoveredDiagnosticAnchorRef.current === null) return;
    hoveredDiagnosticAnchorRef.current = null;
    activeDiagnosticAnchorOffsetRef.current = null;
    setHoveredDiagnosticAnchorOffset(null);
    setHoveredDiagnosticLine(null);
  }, []);

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
    handleEditorGeometryChange();
    keepExecutionLineVisible();
    syncScroll();
  }, [handleEditorGeometryChange, keepExecutionLineVisible, syncScroll]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.addEventListener('scroll', handleEditorGeometryChange, { passive: true });
    editor.addEventListener('scroll', syncScroll, { passive: true });
    const observer = new ResizeObserver(syncAfterResize);
    observer.observe(editor);
    syncScroll();
    return () => {
      editor.removeEventListener('scroll', handleEditorGeometryChange);
      editor.removeEventListener('scroll', syncScroll);
      observer.disconnect();
    };
  }, [editorRef, handleEditorGeometryChange, syncAfterResize, syncScroll]);
  useLayoutEffect(() => {
    diagnosticAnchorHitboxesRef.current = null;
    syncScroll();
  }, [text, highlightLine, diagnosticGroups.length, diagnosticAnchorRanges, syncScroll]);

  useLayoutEffect(() => {
    activeDiagnosticLineRef.current = activeDiagnosticGroup?.line ?? null;
    const activeAnchorOffset = pinnedDiagnosticLine === null
      && focusedDiagnosticLine === null
      && activeDiagnosticLine !== null
      && activeDiagnosticLine === hoveredDiagnosticLine
      ? hoveredDiagnosticAnchorOffset
      : null;
    activeDiagnosticAnchorOffsetRef.current = activeAnchorOffset;
    syncScroll();
  }, [activeDiagnosticGroup, activeDiagnosticLine, focusedDiagnosticLine, hoveredDiagnosticAnchorOffset,
    hoveredDiagnosticLine, pinnedDiagnosticLine, syncScroll]);

  useEffect(() => {
    if (!activeDiagnosticGroup) return;
    const close = () => dismissDiagnosticPopover();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && diagnosticOverlayRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.target instanceof Node && diagnosticOverlayRef.current?.contains(event.target)) {
        event.preventDefault();
      }
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeDiagnosticGroup, dismissDiagnosticPopover]);

  useEffect(() => () => clearDiagnosticCloseTimer(), [clearDiagnosticCloseTimer]);

  useEffect(() => {
    if (diagnosticGroups.length > 0) return;
    setHoveredDiagnosticLine(null);
    clearHoveredDiagnosticAnchor();
    setFocusedDiagnosticLine(null);
    setPinnedDiagnosticLine(null);
    setDismissedDiagnosticLine(null);
  }, [clearHoveredDiagnosticAnchor, diagnosticGroups.length]);

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
        onPointerMove={handleDiagnosticPointerMove}
        onPointerLeave={scheduleDiagnosticClose}
        onCompositionStart={() => {
          isComposingRef.current = true;
          dismissDiagnosticPopover();
        }}
        onCompositionEnd={() => { isComposingRef.current = false; }}
        onInput={dismissDiagnosticPopover}
        onSelect={dismissDiagnosticPopover}
      />
      <div ref={gutterViewportRef} className={`editor-gutter-viewport${compactGutterClass}`} aria-hidden="true">
        <div ref={gutterRef} className="editor-gutter">
          <div className="editor-line-numbers" aria-hidden="true">
            {lineNumberSpans}
          </div>
          {!useCompactReadOnlyGutter && <div className="editor-diagnostic-space" aria-hidden="true" />}
        </div>
      </div>
      {diagnosticGroups.length > 0 && (
        <div ref={diagnosticOverlayRef} className="editor-diagnostic-overlay">
          <div ref={diagnosticMarkersRef} className="editor-diagnostic-markers">
            {diagnosticGroups.map(group => {
              const label = t(
                group.diagnostics.length === 1 ? 'editor.diagnosticMarker.one' : 'editor.diagnosticMarker.many',
                { count: group.diagnostics.length, line: group.line },
              );
              return (
                <button
                  key={group.line}
                  type="button"
                  className="editor-diagnostic-marker"
                  style={{ top: `${8 + (group.line - 1) * 21}px` }}
                  aria-label={label}
                  aria-expanded={activeDiagnosticLine === group.line}
                  aria-describedby={activeDiagnosticLine === group.line ? diagnosticPopoverId : undefined}
                  aria-controls={activeDiagnosticLine === group.line ? diagnosticPopoverId : undefined}
                  onMouseDown={event => event.preventDefault()}
                  onMouseEnter={() => {
                    clearDiagnosticCloseTimer();
                    clearHoveredDiagnosticAnchor();
                    setPinnedDiagnosticLine(null);
                    setDismissedDiagnosticLine(null);
                    setHoveredDiagnosticLine(group.line);
                  }}
                  onMouseLeave={scheduleDiagnosticClose}
                  onFocus={() => {
                    clearDiagnosticCloseTimer();
                    clearHoveredDiagnosticAnchor();
                    const editor = editorRef.current;
                    if (editor) revealEditorLine(editor, group.line);
                    setPinnedDiagnosticLine(null);
                    setDismissedDiagnosticLine(null);
                    setFocusedDiagnosticLine(group.line);
                  }}
                  onBlur={() => setFocusedDiagnosticLine(current => current === group.line ? null : current)}
                  onClick={() => {
                    clearDiagnosticCloseTimer();
                    clearHoveredDiagnosticAnchor();
                    if (pinnedDiagnosticLine === group.line) {
                      setPinnedDiagnosticLine(null);
                      setDismissedDiagnosticLine(group.line);
                    } else {
                      setDismissedDiagnosticLine(null);
                      setPinnedDiagnosticLine(group.line);
                    }
                  }}
                >
                  <span className="editor-diagnostic-marker-glyph" aria-hidden="true">!</span>
                </button>
              );
            })}
          </div>
          {activeDiagnosticGroup && (
            <div
              ref={diagnosticPopoverRef}
              id={diagnosticPopoverId}
              className="editor-diagnostic-popover"
              role="tooltip"
              style={{ top: '8px' }}
              onMouseEnter={clearDiagnosticCloseTimer}
              onMouseLeave={scheduleDiagnosticClose}
            >
              <div className="editor-diagnostic-popover-title">
                {t('editor.diagnosticsForLine', { line: activeDiagnosticGroup.line })}
              </div>
              <ul className="editor-diagnostic-messages">
                {activeDiagnosticGroup.diagnostics.map(diagnostic => (
                  <li key={diagnostic.id}>
                    <div>{diagnostic.message}</div>
                    {diagnostic.relatedLocations.length > 0 && (
                      <>
                        <div className="editor-diagnostic-related-title">{t('editor.relatedLocations')}</div>
                        <ul className="editor-diagnostic-related-locations">
                          {diagnostic.relatedLocations.map((related, index) => (
                            <li key={`${diagnostic.id}:related:${index}`}>
                              <span>{related.message}</span>
                              <code>{t('editor.sourceLocation', {
                                file: related.file,
                                line: related.line,
                                column: related.column,
                              })}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
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
