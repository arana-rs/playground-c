import { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent as ReactUIEvent } from 'react';
import { Button } from './arc/button/button.tsx';
import { getConsoleCopyText, TerminalPresentation } from './terminalPresentation.ts';
import { getPlaygroundShortcut } from '../keyboardShortcuts.ts';
import type { ConsoleDiagnosticLocation, ConsoleOutputSegment, ConsoleStatusTone } from '../execution/useRunner.ts';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';
import { resolveEditorSourceLocation } from '../editor/editorDiagnostics.ts';
import { DiagnosticLocationAction } from './DiagnosticLocationAction.tsx';
import { copyReportText } from '../execution/copyReport.ts';
import { useI18n } from '../i18n.tsx';

interface ConsolePanelProps {
  readonly id?: string;
  readonly className?: string;
  readonly kind?: 'console' | 'debug';
  readonly ariaLabel?: string;
  readonly ariaKeyshortcuts?: string;
  readonly hidden?: boolean;
  readonly visible?: boolean;
  readonly inputResetKey?: string | number;
  readonly statusLabel: string;
  readonly statusTone: ConsoleStatusTone;
  readonly segments: readonly ConsoleOutputSegment[];
  readonly diagnosticFiles?: readonly { readonly id: string; readonly name: string; readonly source: string }[];
  readonly diagnosticSnapshot?: WorkspaceSourceSnapshot;
  readonly onDiagnosticNavigate?: (
    location: ConsoleDiagnosticLocation,
    snapshot: WorkspaceSourceSnapshot,
  ) => 'navigated' | 'stale' | 'unavailable';
  readonly inputRequestId: number | null;
  readonly onSendStdinLine: (line: string) => boolean;
  readonly onSendStdinEOF: () => boolean;
  readonly showStop?: boolean;
  readonly onStop?: () => void;
  readonly actions?: ReactNode;
  readonly scrollKey?: string | number;
  readonly onInputFocus?: () => void;
  readonly onInputBlur?: () => void;
}

export const ConsolePanel = forwardRef<HTMLElement, ConsolePanelProps>(function ConsolePanel({
  id,
  className,
  kind = 'console',
  ariaLabel,
  ariaKeyshortcuts,
  hidden = false,
  visible = true,
  inputResetKey,
  statusLabel,
  statusTone,
  segments,
  diagnosticFiles = [],
  diagnosticSnapshot,
  onDiagnosticNavigate,
  inputRequestId,
  onSendStdinLine,
  onSendStdinEOF,
  showStop = false,
  onStop,
  actions,
  scrollKey,
  onInputFocus,
  onInputBlur,
}, forwardedRef) {
  const { t } = useI18n();
  const outputRef = useRef<HTMLPreElement>(null);
  const stdinRef = useRef<HTMLInputElement>(null);
  const presentationRef = useRef<TerminalPresentation | null>(null);
  const previousInputRequest = useRef<number | null>(null);
  const previousInputResetKey = useRef(inputResetKey);
  const previousVisible = useRef(visible && !hidden);
  const shouldAutoScroll = useRef(true);
  const [stdinDraft, setStdinDraft] = useState('');
  const [outputCopyFeedback, setOutputCopyFeedback] = useState<'copied' | 'failed' | null>(null);
  const [outputCopyAnimationKey, setOutputCopyAnimationKey] = useState(0);
  const [diagnosticNavigationFeedback, setDiagnosticNavigationFeedback] = useState<'stale' | 'unavailable' | null>(null);
  if (!presentationRef.current) presentationRef.current = new TerminalPresentation();
  const presentation = presentationRef.current.update(segments, inputResetKey);
  const outputText = [...presentation.screen, ...presentation.protectedSegments].map(segment => segment.text).join('');
  const copyText = getConsoleCopyText(presentation);

  useLayoutEffect(() => {
    const shown = visible && !hidden;
    if (previousInputResetKey.current !== inputResetKey) {
      previousInputResetKey.current = inputResetKey;
      shouldAutoScroll.current = true;
      setStdinDraft('');
    }
    const newRequest = inputRequestId !== null && inputRequestId !== previousInputRequest.current;
    const reopenedWhileWaiting = shown && !previousVisible.current && inputRequestId !== null;
    if (shown && (newRequest || reopenedWhileWaiting)) {
      stdinRef.current?.focus({ preventScroll: true });
    }
    previousInputRequest.current = inputRequestId;
    previousVisible.current = shown;
  }, [hidden, inputRequestId, inputResetKey, visible]);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output || !shouldAutoScroll.current) return;
    output.scrollTop = output.scrollHeight;
  }, [outputText, inputRequestId, stdinDraft, hidden, visible, scrollKey]);

  function onOutputScroll(event: ReactUIEvent<HTMLPreElement>) {
    const output = event.currentTarget;
    shouldAutoScroll.current = output.scrollHeight - output.clientHeight - output.scrollTop <= 16;
  }

  async function onCopyOutput() {
    if (!copyText) return;
    setOutputCopyFeedback(null);
    try {
      if (await copyReportText(copyText)) {
        setOutputCopyFeedback('copied');
        setOutputCopyAnimationKey(key => key + 1);
      } else {
        setOutputCopyFeedback('failed');
      }
    } catch {
      setOutputCopyFeedback('failed');
    }
  }

  function onStdinKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const nativeEvent = event.nativeEvent;
    if (!getPlaygroundShortcut(nativeEvent)) event.stopPropagation();
    if (event.key !== 'Enter' || event.repeat || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (onSendStdinLine(stdinDraft)) setStdinDraft('');
  }

  function onDiagnosticLocationActivate(location: ConsoleDiagnosticLocation) {
    const outcome = diagnosticSnapshot
      ? onDiagnosticNavigate?.(location, diagnosticSnapshot) ?? 'unavailable'
      : 'unavailable';
    setDiagnosticNavigationFeedback(outcome === 'stale' || outcome === 'unavailable' ? outcome : null);
  }

  function renderSegmentText(segment: ConsoleOutputSegment, segmentIndex: number) {
    const locations = segment.diagnosticLocations;
    if (!locations?.length) return segment.text;

    const content: ReactNode[] = [];
    let cursor = 0;
    for (const [locationIndex, location] of locations.entries()) {
      if (!Number.isSafeInteger(location.start) || !Number.isSafeInteger(location.end)
        || location.start < cursor || location.end <= location.start || location.end > segment.text.length) continue;
      if (location.start > cursor) content.push(segment.text.slice(cursor, location.start));
      const locationText = segment.text.slice(location.start, location.end);
      if (location.sourceId) {
        const resolution = diagnosticSnapshot
          ? resolveEditorSourceLocation(location, diagnosticFiles, diagnosticSnapshot.files)
          : { status: 'unavailable' as const, reason: 'unknown-source' as const };
        content.push(
          <DiagnosticLocationAction
            key={`location-${segmentIndex}-${locationIndex}`}
            text={locationText}
            file={location.file}
            currentFileName={resolution.status === 'available' ? resolution.fileName : undefined}
            line={location.line}
            column={location.column}
            available={resolution.status === 'available'}
            stale={resolution.status === 'available' && resolution.stale}
            onActivate={() => onDiagnosticLocationActivate(location)}
          />,
        );
      } else {
        content.push(locationText);
      }
      cursor = location.end;
    }
    if (cursor < segment.text.length) content.push(segment.text.slice(cursor));
    return content.length > 0 ? content : segment.text;
  }

  return (
    <section
      ref={forwardedRef}
      id={id}
      className={`console${className ? ` ${className}` : ''}${inputRequestId !== null ? ' console-waiting' : ''}`}
      aria-label={ariaLabel ?? t(kind === 'debug' ? 'console.debugAriaLabel' : 'console.ariaLabel')}
      aria-keyshortcuts={ariaKeyshortcuts}
      aria-hidden={hidden || undefined}
      hidden={hidden}
      tabIndex={-1}
    >
      <div className="console-label">
        <div className="console-title-group">
          <span>{t(kind === 'debug' ? 'console.debugLabel' : 'console.label')}</span>
          <Button
            className={`console-output-copy-button${outputCopyFeedback ? ` is-${outputCopyFeedback}` : ''}`}
            variant="ghost"
            size="sm"
            type="button"
            aria-label={t('console.copyOutputLabel')}
            title={t('console.copyOutputLabel')}
            disabled={!copyText}
            onClick={onCopyOutput}
          >
            <svg key={outputCopyAnimationKey} className="console-output-copy-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <g className="console-output-copy-mark">
                <rect x="5.5" y="2.5" width="8" height="10" rx="1" />
                <path d="M10.5 13.5h-6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h1" />
              </g>
              <path className="console-output-check-mark" d="m3.5 8.25 2.75 2.75 6.25-6.5" />
            </svg>
          </Button>
          <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {outputCopyFeedback === 'copied'
              ? t('console.outputCopied')
              : outputCopyFeedback === 'failed' ? t('console.outputCopyFailed') : ''}
          </span>
        </div>
        <div className="console-actions">
          {inputRequestId !== null && (
            <Button
              className="console-eof-button"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('console.sendEof')}
              onClick={onSendStdinEOF}
            >
              EOF
            </Button>
          )}
          {showStop && onStop && (
            <Button
              className="console-stop-button"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('console.stopDebugging')}
              onClick={onStop}
            >
              {t('run.stop')}
            </Button>
          )}
          {actions}
          {diagnosticNavigationFeedback === 'stale' && (
            <span className="console-navigation-feedback" role="status" aria-live="polite" aria-atomic="true">
              {t('diagnostic.staleHint')}
            </span>
          )}
          {diagnosticNavigationFeedback === 'unavailable' && (
            <span className="console-navigation-feedback" role="status" aria-live="polite" aria-atomic="true">
              {t('diagnostic.unavailableHint')}
            </span>
          )}
          <span className={`console-status console-status-${statusTone}`} title={statusLabel} role="status" aria-live="polite" aria-atomic="true">
            <span>{statusLabel}</span>
          </span>
        </div>
      </div>
      <pre ref={outputRef} className="console-output" role="log" aria-live="off" aria-atomic="true" onScroll={onOutputScroll}>
        {presentation.screen.map((segment, index) => (
          <span
            key={`screen-${index}`}
            className={`console-output-${segment.tone}`}
            data-stream={segment.stream}
            role={segment.stream === 'stderr' ? 'group' : undefined}
            aria-label={segment.stream === 'stderr' ? t('console.stderrOutput') : undefined}
          >
            {renderSegmentText(segment, index)}
          </span>
        ))}
        {presentation.protectedSegments.map((segment, index) => (
          <span key={`protected-${index}`} className={`console-output-${segment.tone}`} data-stream={segment.stream}>
            {renderSegmentText(segment, index + presentation.screen.length)}
          </span>
        ))}
        {inputRequestId !== null && (
          <input
            ref={stdinRef}
            className="console-stdin"
            aria-label={t('console.stdinLabel')}
            aria-description={t('console.stdinDescription')}
            aria-keyshortcuts="Enter"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t('console.stdinPlaceholder')}
            value={stdinDraft}
            onChange={event => setStdinDraft(event.currentTarget.value)}
            onKeyDown={onStdinKeyDown}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
          />
        )}
      </pre>
    </section>
  );
});
