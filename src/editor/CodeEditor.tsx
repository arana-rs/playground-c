import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { getEditorLineCount, MAX_EDITOR_LINES } from './limits.ts';
import type { EditorLimitMessage } from './limits.ts';
import {
  createDiagnosticAnchorHitbox,
  findDiagnosticAnchorAtPoint,
  getDiagnosticPopoverVerticalPlacement,
} from './diagnosticRendering.ts';
import type { DiagnosticAnchorHitbox } from './diagnosticRendering.ts';
import type { EditorDiagnosticGroup } from './editorDiagnostics.ts';
import type { EditorCompletionState } from './useCodeEditor.ts';
import { useI18n } from '../i18n.tsx';
import {
  CodeEditorDiagnosticOverlay,
  getDiagnosticPopoverTop,
} from './CodeEditorDiagnosticOverlay.tsx';
import { useCodeEditorCompletionOverlay } from './CodeEditorCompletionOverlay.tsx';
import { CodeEditorInput } from './CodeEditorInput.tsx';
import { CodeEditorLimitStatus } from './CodeEditorLimitStatus.tsx';
import { CodeEditorGutterLayer, CodeEditorHighlightLayer } from './CodeEditorVisualLayers.tsx';
import { getEditorDiagnosticAnchorRanges } from './editorDiagnosticAnchors.ts';

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
  completion?: EditorCompletionState | null;
  onCompletionAccept?: (index: number) => boolean;
  onCompletionDismiss?: () => void;
}

export const CodeEditor = memo(function CodeEditor({
  editorRef, text, initialText = '', activeLine = 1, highlightLine,
  readOnly = false, showActiveLine = true, compactReadOnlyGutter = false,
  limitMessage = null, diagnostics = [], completion = null, onCompletionAccept,
  onCompletionDismiss,
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
  const [hoveredDiagnosticLine, setHoveredDiagnosticLine] = useState<number | null>(null);
  const [hoveredDiagnosticAnchorOffset, setHoveredDiagnosticAnchorOffset] = useState<number | null>(null);
  const [focusedDiagnosticLine, setFocusedDiagnosticLine] = useState<number | null>(null);
  const [pinnedDiagnosticLine, setPinnedDiagnosticLine] = useState<number | null>(null);
  const [dismissedDiagnosticLine, setDismissedDiagnosticLine] = useState<number | null>(null);
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
  const diagnosticAnchorRanges = useMemo(
    () => getEditorDiagnosticAnchorRanges(text, diagnosticGroups),
    [diagnosticGroups, text],
  );

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
  const {
    popoverId: completionPopoverId,
    positionPopover: positionCompletionPopover,
    dismissOffscreen: dismissOffscreenCompletion,
    overlay: completionOverlay,
  } = useCodeEditorCompletionOverlay({
    editorRef,
    completion,
    onCompletionAccept,
    onCompletionDismiss,
  });

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
    dismissOffscreenCompletion();
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
    positionCompletionPopover();
  }, [dismissOffscreenCompletion, editorRef, positionCompletionPopover]);

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
  }, [text, highlightLine, completion, diagnosticGroups.length, diagnosticAnchorRanges, syncScroll]);

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
      <CodeEditorHighlightLayer
        text={text}
        lineCount={lineCount}
        readOnly={readOnly}
        highlightLine={highlightLine}
        compactGutterClass={compactGutterClass}
        diagnosticAnchorRanges={diagnosticAnchorRanges}
        viewportRef={viewportRef}
        highlightRef={highlightRef}
        executionLineRef={executionLineRef}
      />
      <CodeEditorInput
        editorRef={editorRef}
        className={`editor${readOnly ? ' is-readonly' : ''}${compactGutterClass}`}
        accessibleLabel={t('editor.codeAreaLabel', { file: 'main.c' })}
        initialText={initialText}
        readOnly={readOnly}
        completion={completion}
        completionPopoverId={completionPopoverId}
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
      <CodeEditorGutterLayer
        lineCount={lineCount}
        activeLine={activeLine}
        showActiveLine={showActiveLine}
        compactGutterClass={compactGutterClass}
        useCompactReadOnlyGutter={useCompactReadOnlyGutter}
        gutterViewportRef={gutterViewportRef}
        gutterRef={gutterRef}
      />
      <CodeEditorDiagnosticOverlay
        groups={diagnosticGroups}
        activeLine={activeDiagnosticLine}
        activeGroup={activeDiagnosticGroup}
        editorRef={editorRef}
        overlayRef={diagnosticOverlayRef}
        markersRef={diagnosticMarkersRef}
        popoverRef={diagnosticPopoverRef}
        clearDiagnosticCloseTimer={clearDiagnosticCloseTimer}
        clearHoveredDiagnosticAnchor={clearHoveredDiagnosticAnchor}
        scheduleDiagnosticClose={scheduleDiagnosticClose}
        onMarkerEnter={line => {
          setPinnedDiagnosticLine(null);
          setDismissedDiagnosticLine(null);
          setHoveredDiagnosticLine(line);
        }}
        onMarkerFocus={line => {
          setPinnedDiagnosticLine(null);
          setDismissedDiagnosticLine(null);
          setFocusedDiagnosticLine(line);
        }}
        onMarkerBlur={line => setFocusedDiagnosticLine(current => current === line ? null : current)}
        onMarkerClick={line => {
          if (pinnedDiagnosticLine === line) {
            setPinnedDiagnosticLine(null);
            setDismissedDiagnosticLine(line);
          } else {
            setDismissedDiagnosticLine(null);
            setPinnedDiagnosticLine(line);
          }
        }}
      />
      {completionOverlay}
      <CodeEditorLimitStatus limitMessage={limitMessage} />
    </>
  );
});
