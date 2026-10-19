import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { Button } from '../components/arc/button/button.tsx';
import { ConsolePanel } from '../components/ConsolePanel.tsx';
import { SelectedFileTab } from '../components/SelectedFileTab.tsx';
import { CodeEditor } from '../editor/CodeEditor.tsx';
import { formatConsoleSegments } from '../execution/useRunner.ts';
import type { ConsoleEntry, ConsoleStatusTone } from '../execution/useRunner.ts';
import type { RunConfiguration } from '../execution/configuration.ts';
import { useMemoryViewer } from './useMemoryViewer.ts';
import { hasDirectStdioInclude } from './stdioInclude.ts';
import type { MemoryViewerPlaybackInterval } from './playbackSpeed.ts';
import { MEMORY_VIEWER_MODES } from './MemoryViewerRegionModel.ts';
import type { MemoryViewerMode } from './MemoryViewerRegionModel.ts';
import { MemoryViewerRegions } from './MemoryViewerRegions.tsx';
import {
  readMemoryViewerIoConsolePreference,
  writeMemoryViewerIoConsolePreference,
} from './ioConsolePreference.ts';
import { useI18n } from '../i18n.tsx';
import type { Translate } from '../i18n.tsx';

export { MemoryViewerAggregateBlock } from './MemoryViewerAggregateBlock.tsx';
export type { MemoryViewerAggregateBlockProps } from './MemoryViewerAggregateBlock.tsx';
export { MemoryViewerArrayBlock } from './MemoryViewerArrayBlock.tsx';

interface MemoryViewerProps {
  source: string;
  configuration: RunConfiguration;
  playbackIntervalMs: MemoryViewerPlaybackInterval;
  onClose: () => void;
}

function getStatusLabel(
  status: ReturnType<typeof useMemoryViewer>['status'],
  isPlaying: boolean,
  t: Translate,
) {
  switch (status) {
    case 'starting': return t('memoryViewer.status.preparing');
    case 'paused': return isPlaying ? t('memoryViewer.status.playing') : t('memoryViewer.status.paused');
    case 'running': return isPlaying ? t('memoryViewer.status.playing') : t('memoryViewer.status.stepping');
    case 'waiting-input': return t('memoryViewer.status.waitingInput');
    case 'terminated': return t('memoryViewer.status.programEnded');
    case 'cancelled': return t('memoryViewer.status.stopped');
    case 'error': return t('memoryViewer.status.error');
    case 'limit': return t('memoryViewer.status.limit');
  }
}

function getDebugConsoleStatus(
  status: ReturnType<typeof useMemoryViewer>['status'],
  isPlaying: boolean,
  isViewingHistory: boolean,
  inputRequestId: number | null,
  t: Translate,
): { label: string; tone: ConsoleStatusTone } {
  if (status === 'cancelled') return { label: t('memoryViewer.status.stopped'), tone: 'cancelled' };
  if (isViewingHistory) return { label: t('memoryViewer.status.historySelected'), tone: 'ready' };
  if (inputRequestId !== null || status === 'waiting-input') return { label: t('memoryViewer.status.waitingInput'), tone: 'waiting' };
  if (status === 'starting') return { label: t('memoryViewer.status.preparing'), tone: 'running' };
  if (status === 'running' || (status === 'paused' && isPlaying)) return { label: t('memoryViewer.status.stepping'), tone: 'running' };
  if (status === 'terminated') return { label: t('memoryViewer.status.finished'), tone: 'finished' };
  if (status === 'error') return { label: t('memoryViewer.status.error'), tone: 'error' };
  if (status === 'limit') return { label: t('memoryViewer.status.limitReached'), tone: 'stopped' };
  return { label: t('memoryViewer.status.paused'), tone: 'ready' };
}

function isOutsideDialogBounds(dialog: HTMLDialogElement, clientX: number, clientY: number) {
  const bounds = dialog.getBoundingClientRect();
  return clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom;
}

export function MemoryViewer({ source, configuration, playbackIntervalMs, onClose }: MemoryViewerProps) {
  const { language, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const backdropPointerIdRef = useRef<number | null>(null);
  const [mode, setMode] = useState<MemoryViewerMode>('minimal');
  const {
    source: frozenSource,
    location,
    status,
    isPlaying,
    stepIndex,
    hasUsedHeap,
    hasHeapAllocationCalls,
    lifecycle,
    activeScopes,
    heapObjects,
    pointers,
    arrays,
    omittedArrayObjects,
    aggregates,
    omittedAggregateObjects,
    stackScalars,
    staticObjects,
    canPrevious,
    canNext,
    canStop,
    transcript,
    inputRequestId,
    isViewingHistory,
    errorMessage,
    historyNotice,
    togglePlay,
    previous,
    next,
    sendStdinLine,
    sendStdinEOF,
    setConsoleEnabled,
    stop,
    transcriptRevision,
  } = useMemoryViewer(source, configuration, false, playbackIntervalMs);
  const hasStdioInclude = useMemo(() => hasDirectStdioInclude(frozenSource), [frozenSource]);
  const [ioPreference, setIoPreference] = useState(
    () => readMemoryViewerIoConsolePreference(() => window.localStorage),
  );
  const updateIoPreference = (enabled: boolean) => {
    setIoPreference(enabled);
    writeMemoryViewerIoConsolePreference(() => window.localStorage, enabled);
  };
  const showIoConsole = hasStdioInclude && ioPreference;
  useEffect(() => {
    setConsoleEnabled(showIoConsole);
  }, [setConsoleEnabled, showIoConsole]);
  const hasMainSourceLocation = location?.file === 'main.c';
  const consoleTranscript = useMemo<readonly ConsoleEntry[]>(
    () => transcript.map(entry => entry.stream === 'system'
      ? { stream: 'system', text: entry.text, tone: entry.tone, role: entry.role }
      : { stream: entry.stream, text: entry.text }),
    [transcript, transcriptRevision],
  );
  const consoleSegments = useMemo(
    () => formatConsoleSegments({ status: 'running', transcript: consoleTranscript, inputRequestId }),
    [consoleTranscript, inputRequestId],
  );
  const consoleStatus = getDebugConsoleStatus(status, isPlaying, isViewingHistory, inputRequestId, t);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  function closeFromEscape(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    onClose();
  }

  function rememberBackdropPointer(event: ReactPointerEvent<HTMLDialogElement>) {
    backdropPointerIdRef.current = null;
    if (!event.isPrimary || event.button !== 0 || event.target !== event.currentTarget) return;
    if (isOutsideDialogBounds(event.currentTarget, event.clientX, event.clientY)) {
      backdropPointerIdRef.current = event.pointerId;
    }
  }

  function validateBackdropPointerEnd(event: ReactPointerEvent<HTMLDialogElement>) {
    if (backdropPointerIdRef.current !== event.pointerId) return;
    if (!event.isPrimary
      || event.button !== 0
      || event.target !== event.currentTarget
      || !isOutsideDialogBounds(event.currentTarget, event.clientX, event.clientY)) {
      backdropPointerIdRef.current = null;
    }
  }

  function clearCancelledBackdropPointer(event: ReactPointerEvent<HTMLDialogElement>) {
    if (backdropPointerIdRef.current === event.pointerId) backdropPointerIdRef.current = null;
  }

  function closeFromBackdrop(event: ReactMouseEvent<HTMLDialogElement>) {
    const startedOutside = backdropPointerIdRef.current !== null;
    backdropPointerIdRef.current = null;
    if (!startedOutside
      || event.target !== event.currentTarget
      || !isOutsideDialogBounds(event.currentTarget, event.clientX, event.clientY)) return;
    onClose();
  }

  const locationLabel = location
    ? hasMainSourceLocation
      ? `main.c:${location.line}:${location.column}`
      : t('memoryViewer.location', { file: location.file, line: location.line, column: location.column })
    : '';

  return (
    <dialog
      ref={dialogRef}
      className="memory-viewer-dialog"
      aria-labelledby="memory-viewer-title"
      onCancel={closeFromEscape}
      onPointerDown={rememberBackdropPointer}
      onPointerUp={validateBackdropPointerEnd}
      onPointerCancel={clearCancelledBackdropPointer}
      onClick={closeFromBackdrop}
    >
      <div className="memory-viewer-window" data-memory-viewer-mode={mode}>
        <header className="memory-viewer-header">
          <div className="memory-viewer-controls" aria-label={t('memoryViewer.controls')}>
            <Button
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t(isPlaying ? 'memoryViewer.pause' : 'memoryViewer.play')}
              title={t(isPlaying ? 'memoryViewer.pause' : 'memoryViewer.play')}
              disabled={status === 'starting' || status === 'waiting-input' || status === 'terminated' || status === 'cancelled' || status === 'error' || status === 'limit'}
              onClick={togglePlay}
            >
              {isPlaying ? (
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M5 3.5v9M11 3.5v9" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M4 2.5 13 8l-9 5.5Z" />
                </svg>
              )}
            </Button>
            <Button
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('memoryViewer.previous')}
              title={t('memoryViewer.previous')}
              disabled={!canPrevious}
              onClick={previous}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 3v10M12.5 3.5 6 8l6.5 4.5Z" />
              </svg>
            </Button>
            <Button
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('memoryViewer.next')}
              title={t('memoryViewer.next')}
              disabled={!canNext}
              onClick={next}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M12 3v10M3.5 3.5 10 8l-6.5 4.5Z" />
              </svg>
            </Button>
          </div>
          <h2 id="memory-viewer-title">{t('memoryViewer.title')}</h2>
          <div className="memory-viewer-header-actions">
            <label className="memory-viewer-io-toggle" data-disabled={!hasStdioInclude || undefined} title={t(hasStdioInclude ? 'memoryViewer.ioToggle' : 'memoryViewer.ioUnavailable')}>
              <input
                type="checkbox"
                checked={showIoConsole}
                disabled={!hasStdioInclude}
                onChange={event => updateIoPreference(event.currentTarget.checked)}
              />
              <span>{t('memoryViewer.io')}</span>
            </label>
            <select
              className="memory-viewer-mode-select"
              aria-label={t('memoryViewer.mode')}
              title={t('memoryViewer.mode')}
              value={mode}
              onChange={event => setMode(event.currentTarget.value as MemoryViewerMode)}
            >
              {MEMORY_VIEWER_MODES.map(option => (
                <option key={option.value} value={option.value}>
                  {t(option.value === 'minimal' ? 'memoryViewer.mode.minimal' : option.value === 'normal' ? 'memoryViewer.mode.normal' : 'memoryViewer.mode.debug')}
                </option>
              ))}
            </select>
            {canStop && !showIoConsole && (
              <Button
                className="memory-viewer-control"
                variant="ghost"
                size="sm"
                type="button"
                aria-label={t('memoryViewer.stopDebugging')}
                title={t('memoryViewer.stopDebugging')}
                onClick={stop}
              >
                {t('run.stop')}
              </Button>
            )}
            <Button
              ref={closeButtonRef}
              className="memory-viewer-control memory-viewer-icon-control"
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('memoryViewer.close')}
              onClick={onClose}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </Button>
          </div>
        </header>
        <div className="memory-viewer-filebar">
          <SelectedFileTab fileName="main.c" />
          <span className="memory-viewer-status" role="status" aria-live="polite" aria-atomic="true">
            {isViewingHistory ? t('memoryViewer.status.historySelected') : getStatusLabel(status, isPlaying, t)}
          </span>
          {locationLabel && <span className="memory-viewer-location">{locationLabel}</span>}
        </div>
        {historyNotice && (
          <p className="memory-viewer-history-notice" role="status" aria-live="polite">
            {t(historyNotice === 1 ? 'memoryViewer.historyNotice.one' : 'memoryViewer.historyNotice.other', {
              count: new Intl.NumberFormat(language).format(historyNotice),
            })}
          </p>
        )}
        {errorMessage && (
          <p className="memory-viewer-error" role="alert">{errorMessage}</p>
        )}
        <main className="editor-pane memory-viewer-editor-pane">
          <CodeEditor
            editorRef={editorRef}
            text={frozenSource}
            initialText={frozenSource}
            activeLine={hasMainSourceLocation ? location.line : 1}
            highlightLine={hasMainSourceLocation ? location.line : undefined}
            readOnly
            showActiveLine={hasMainSourceLocation}
            compactReadOnlyGutter
          />
        </main>
        <MemoryViewerRegions
          mode={mode}
          hasUsedHeap={hasUsedHeap}
          hasHeapAllocationCalls={hasHeapAllocationCalls}
          lifecycle={lifecycle}
          activeScopes={activeScopes}
          heapObjects={heapObjects}
          arrays={arrays}
          omittedArrayObjects={omittedArrayObjects}
          aggregates={aggregates}
          omittedAggregateObjects={omittedAggregateObjects}
          stackScalars={stackScalars}
          pointers={pointers}
          staticObjects={staticObjects}
          stepIndex={stepIndex}
          status={status}
        />
        <ConsolePanel
          className="memory-viewer-console"
          kind="debug"
          hidden={!showIoConsole}
          statusLabel={consoleStatus.label}
          statusTone={consoleStatus.tone}
          segments={consoleSegments}
          inputRequestId={inputRequestId}
          onSendStdinLine={sendStdinLine}
          onSendStdinEOF={sendStdinEOF}
          showStop={canStop}
          onStop={stop}
        />
      </div>
    </dialog>
  );
}
