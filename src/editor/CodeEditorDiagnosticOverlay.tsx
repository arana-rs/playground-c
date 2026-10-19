import { useId } from 'react';
import type { RefObject } from 'react';
import type { EditorDiagnosticGroup } from './editorDiagnostics.ts';
import { useI18n } from '../i18n.tsx';

export function getDiagnosticPopoverTop(
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

export function revealEditorLine(editor: HTMLTextAreaElement, line: number): void {
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

interface CodeEditorDiagnosticOverlayProps {
  groups: readonly EditorDiagnosticGroup[];
  activeLine: number | null;
  activeGroup: EditorDiagnosticGroup | undefined;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
  markersRef: RefObject<HTMLDivElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  clearDiagnosticCloseTimer: () => void;
  clearHoveredDiagnosticAnchor: () => void;
  scheduleDiagnosticClose: () => void;
  onMarkerEnter: (line: number) => void;
  onMarkerFocus: (line: number) => void;
  onMarkerBlur: (line: number) => void;
  onMarkerClick: (line: number) => void;
}

export function CodeEditorDiagnosticOverlay({
  groups,
  activeLine,
  activeGroup,
  editorRef,
  overlayRef,
  markersRef,
  popoverRef,
  clearDiagnosticCloseTimer,
  clearHoveredDiagnosticAnchor,
  scheduleDiagnosticClose,
  onMarkerEnter,
  onMarkerFocus,
  onMarkerBlur,
  onMarkerClick,
}: CodeEditorDiagnosticOverlayProps) {
  const { t } = useI18n();
  const popoverId = useId();

  if (groups.length === 0) return null;

  return (
    <div ref={overlayRef} className="editor-diagnostic-overlay">
      <div ref={markersRef} className="editor-diagnostic-markers">
        {groups.map(group => {
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
              aria-expanded={activeLine === group.line}
              aria-describedby={activeLine === group.line ? popoverId : undefined}
              aria-controls={activeLine === group.line ? popoverId : undefined}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => {
                clearDiagnosticCloseTimer();
                clearHoveredDiagnosticAnchor();
                onMarkerEnter(group.line);
              }}
              onMouseLeave={scheduleDiagnosticClose}
              onFocus={() => {
                clearDiagnosticCloseTimer();
                clearHoveredDiagnosticAnchor();
                const editor = editorRef.current;
                if (editor) revealEditorLine(editor, group.line);
                onMarkerFocus(group.line);
              }}
              onBlur={() => onMarkerBlur(group.line)}
              onClick={() => {
                clearDiagnosticCloseTimer();
                clearHoveredDiagnosticAnchor();
                onMarkerClick(group.line);
              }}
            >
              <span className="editor-diagnostic-marker-glyph" aria-hidden="true">!</span>
            </button>
          );
        })}
      </div>
      {activeGroup && (
        <div
          ref={popoverRef}
          id={popoverId}
          className="editor-diagnostic-popover"
          role="tooltip"
          style={{ top: '8px' }}
          onMouseEnter={clearDiagnosticCloseTimer}
          onMouseLeave={scheduleDiagnosticClose}
        >
          <div className="editor-diagnostic-popover-title">
            {t('editor.diagnosticsForLine', { line: activeGroup.line })}
          </div>
          <ul className="editor-diagnostic-messages">
            {activeGroup.diagnostics.map(diagnostic => (
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
  );
}
