import type { Dispatch, DragEventHandler, RefObject, SetStateAction } from 'react';
import { Button, ButtonSpinner } from '../components/arc/button/button.tsx';
import { ConsolePanel } from '../components/ConsolePanel.tsx';
import { ExecutionSettings } from '../components/ExecutionSettings.tsx';
import { LanguageSwitch } from '../components/LanguageSwitch.tsx';
import { ThemeSwitch } from '../components/arc/theme-switch/theme-switch.tsx';
import { WorkspaceFileTabs } from '../components/WorkspaceFileTabs.tsx';
import { FileDropNotice } from '../components/FileDropNotice.tsx';
import type { FileDropNoticeState } from '../components/FileDropNotice.tsx';
import { CodeEditor } from '../editor/CodeEditor.tsx';
import type { WorkspaceFile } from '../editor/sourcePersistence.ts';
import type { EditorDiagnosticGroup, EditorSourceLocationTarget } from '../editor/editorDiagnostics.ts';
import type { EditorLimitMessage } from '../editor/limits.ts';
import type { EditorCompletionState } from '../editor/useCodeEditor.ts';
import { SyntaxAnalysisControl } from '../editor/SyntaxAnalysisControl.tsx';
import type { SyntaxAnalysisMode } from '../editor/syntaxAnalysisPreference.ts';
import type { SyntaxAnalysisState } from '../editor/syntaxAnalysisController.ts';
import type { ExecutionSettings as ExecutionSettingsValue } from '../execution/settings.ts';
import type { RunConfiguration } from '../execution/configuration.ts';
import type { WorkspaceSourceSnapshot } from '../execution/documentSnapshot.ts';
import type {
  ConsoleOutputSegment,
  ConsoleStatusTone,
  RunDiagnosticsReport,
} from '../execution/useRunner.ts';
import { MemoryViewer } from '../memory/MemoryViewer.tsx';
import type { MemoryViewerPlaybackInterval } from '../memory/playbackSpeed.ts';
import { isMacPlatform } from '../keyboardShortcuts.ts';
import type { ColorTheme } from './useColorTheme.ts';
import type { useConsoleLayout } from './useConsoleLayout.ts';
import { useI18n } from '../i18n.tsx';
import type { DiagnosticNavigationOutcome } from '../components/DiagnosticLocationAction.tsx';
import type { FileDropTarget } from '../editor/fileDropImport.ts';

const GITHUB_REPOSITORY_URL = 'https://github.com/arana-rs/playground-c';
const buildCommit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';

type ConsoleLayout = ReturnType<typeof useConsoleLayout>;

interface PlaygroundShellProps {
  theme: {
    colorTheme: ColorTheme;
    onChange: (next: 'light' | 'dark', trigger: HTMLButtonElement) => void;
  };
  memoryViewer: {
    buttonRef: RefObject<HTMLButtonElement | null>;
    open: boolean;
    document: WorkspaceSourceSnapshot | null;
    canOpen: boolean;
    configuration: RunConfiguration;
    onOpen: () => void;
    onClose: () => void;
  };
  run: {
    isRunning: boolean;
    showStop: boolean;
    canRun: boolean;
    onRun: () => void;
  };
  editor: {
    ref: RefObject<HTMLTextAreaElement | null>;
    text: string;
    fileName: string;
    persistenceLocked: boolean;
    files: readonly WorkspaceFile[];
    activeFileId: string;
    requestedFileId: string;
    isComposing: boolean;
    onSelectFile: (fileId: string) => void;
    onCreateFile: () => WorkspaceFile | null;
    onRenameFile: (fileId: string, name: string) => void;
    onDeleteFile: (fileId: string) => void;
    initialText: string;
    cursor: { line: number; column: number };
    limitMessage: EditorLimitMessage | null;
    diagnostics: readonly EditorDiagnosticGroup[];
    sourceSnapshot: WorkspaceSourceSnapshot;
    onDiagnosticNavigate: (
      location: EditorSourceLocationTarget,
      snapshot: WorkspaceSourceSnapshot,
    ) => DiagnosticNavigationOutcome;
    completion: EditorCompletionState | null;
    onCompletionAccept: (index: number) => boolean;
    onCompletionDismiss: () => void;
    syntaxMode: SyntaxAnalysisMode;
    syntaxState: SyntaxAnalysisState;
    onSyntaxModeChange: (mode: SyntaxAnalysisMode) => void;
  };
  console: {
    layout: ConsoleLayout;
    statusLabel: string;
    statusTone: ConsoleStatusTone;
    segments: readonly ConsoleOutputSegment[];
    diagnosticFiles: readonly WorkspaceFile[];
    diagnosticSnapshot?: WorkspaceSourceSnapshot;
    onDiagnosticNavigate: (
      location: EditorSourceLocationTarget,
      snapshot: WorkspaceSourceSnapshot,
    ) => DiagnosticNavigationOutcome;
    inputRequestId: number | null;
    inputResetKey: number;
    onSendStdinLine: (line: string) => boolean;
    onSendStdinEOF: () => boolean;
    timeoutReport: RunDiagnosticsReport | null;
    copyFeedback: 'copied' | 'failed' | null;
    onCopyTimeoutReport: () => void;
  };
  footer: {
    executionSettings: ExecutionSettingsValue;
    playbackIntervalMs: MemoryViewerPlaybackInterval;
    onApplyExecutionSettings: Dispatch<SetStateAction<ExecutionSettingsValue>>;
    onPlaybackIntervalChange: (interval: MemoryViewerPlaybackInterval) => void;
    onLoadDebugExample: () => void;
    debugExampleDisabled: boolean;
  };
  fileDrop: {
    target: FileDropTarget | null;
    notice: FileDropNoticeState | null;
    onDismissNotice: (id: number) => void;
    onDragEnterCapture: DragEventHandler<HTMLDivElement>;
    onDragOverCapture: DragEventHandler<HTMLDivElement>;
    onDragLeaveCapture: DragEventHandler<HTMLDivElement>;
    onDropCapture: DragEventHandler<HTMLDivElement>;
  };
}

export function PlaygroundShell({ theme, memoryViewer, run, editor, console: consoleState, footer, fileDrop }: PlaygroundShellProps) {
  const { t } = useI18n();
  const { layout } = consoleState;
  const { viewportRect, consoleVisible, isResizingConsole, consoleResizerRef, consolePanelRef,
    consoleHeightBounds, consoleHeight, playgroundRows, playgroundStyle, measureVisibleViewport,
    onConsoleResizePointerDown, onConsoleResizePointerMove, finishConsoleResize,
    onConsoleResizeKeyDown } = layout;

  const { colorTheme, onChange: onChangeColorTheme } = theme;
  const { buttonRef: memoryViewerButtonRef, open: memoryViewerOpen, document: memoryViewerDocument,
    canOpen: canOpenMemoryViewer, configuration: executionConfiguration,
    onOpen: openMemoryViewer, onClose: closeMemoryViewer } = memoryViewer;
  const { isRunning, showStop, canRun, onRun } = run;
  const { ref, text, fileName, files, activeFileId, requestedFileId, isComposing,
    persistenceLocked,
    onSelectFile, onCreateFile, onRenameFile, onDeleteFile,
    initialText, cursor, limitMessage, diagnostics, sourceSnapshot, onDiagnosticNavigate, completion,
    onCompletionAccept, onCompletionDismiss, syntaxMode, syntaxState, onSyntaxModeChange } = editor;
  const { statusLabel: consoleStatusLabel, statusTone: consoleStatusTone, segments: consoleSegments,
    inputRequestId, inputResetKey, onSendStdinLine, onSendStdinEOF, timeoutReport, copyFeedback,
    onCopyTimeoutReport, diagnosticFiles, diagnosticSnapshot } = consoleState;
  const { executionSettings, playbackIntervalMs, onApplyExecutionSettings,
    onPlaybackIntervalChange, onLoadDebugExample, debugExampleDisabled } = footer;

  return (
    <div
      className={`playground${isResizingConsole ? ' is-resizing-console' : ''}${playgroundRows.compactKeyboard ? ' is-keyboard-compact' : ''}`}
      style={playgroundStyle}
      onDragEnterCapture={fileDrop.onDragEnterCapture}
      onDragOverCapture={fileDrop.onDragOverCapture}
      onDragLeaveCapture={fileDrop.onDragLeaveCapture}
      onDropCapture={fileDrop.onDropCapture}
    >
      <header className="header">
        <div className="header-brand">
          <span>Playground for C</span>
          <Button
            ref={memoryViewerButtonRef}
            className="memory-viewer-open-button"
            variant="secondary"
            size="sm"
            type="button"
            aria-label={t('memoryViewer.open')}
            aria-haspopup="dialog"
            aria-expanded={memoryViewerOpen}
            aria-description={canOpenMemoryViewer ? undefined : t('run.entryRequired')}
            title={canOpenMemoryViewer ? undefined : t('run.entryRequired')}
            disabled={!canOpenMemoryViewer}
            onClick={openMemoryViewer}
            leadingIcon={(
              <svg className="run-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
                <path d="M6 6h4M6 8h4M6 10h2M2 5v1M2 8v1M2 11v1M13 5v1M13 8v1M13 11v1" />
              </svg>
            )}
          >
            {t('memoryViewer.title')}
          </Button>
        </div>
        <div className="header-actions">
          <ThemeSwitch
            className="theme-toggle-button"
            theme={colorTheme === 'github-dark' ? 'dark' : 'light'}
            label={t(colorTheme === 'github-dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
            title={t(colorTheme === 'github-dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
            onThemeChange={onChangeColorTheme}
          />
          <LanguageSwitch />
        </div>
      </header>
      <div
        className={`file-tabs${persistenceLocked ? ' is-workspace-locked' : ''}${!persistenceLocked && fileDrop.target === 'tabs' ? ' is-file-drop-target' : ''}`}
        data-file-drop-zone="tabs"
      >
        <WorkspaceFileTabs
          files={files}
          activeFileId={activeFileId}
          requestedFileId={requestedFileId}
          isComposing={isComposing}
          persistenceLocked={persistenceLocked}
          onSelectFile={onSelectFile}
          onCreateFile={onCreateFile}
          onRenameFile={onRenameFile}
          onDeleteFile={onDeleteFile}
        />
        <Button
          className="run-button"
          variant="secondary"
          size="sm"
          type="button"
          aria-keyshortcuts={`${isMacPlatform() ? 'Meta' : 'Control'}+Enter`}
          aria-busy={isRunning || undefined}
          aria-label={t(isRunning ? 'run.stop' : 'run.label')}
          aria-description={isRunning ? t('run.stopDescription') : canRun ? undefined : t('run.entryRequired')}
          title={isRunning || canRun ? undefined : t('run.entryRequired')}
          disabled={!isRunning && !canRun}
          onClick={onRun}
          leadingIcon={
            isRunning && !showStop ? <ButtonSpinner /> : (
              <svg className="run-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                {showStop ? <rect x="3.5" y="3.5" width="9" height="9" /> : <path d="M4 2.5 13 8l-9 5.5Z" />}
              </svg>
            )
          }
        >
          {t(showStop ? 'run.stop' : 'run.label')}
        </Button>
        {persistenceLocked && (
          <WorkspacePersistenceNotice />
        )}
      </div>
        <main
        id="editor-pane"
          data-file-drop-zone="editor"
          className={`editor-pane${syntaxMode === 'off' ? ' is-diagnostics-off' : ''}${!persistenceLocked && fileDrop.target === 'editor' ? ' is-file-drop-target' : ''}`}
      >
        <CodeEditor
          editorRef={ref}
          text={text}
          fileName={fileName}
          readOnly={persistenceLocked}
          initialText={initialText}
          activeLine={cursor.line}
          limitMessage={limitMessage}
          diagnostics={diagnostics}
          sourceFiles={files}
          sourceSnapshot={sourceSnapshot}
          onDiagnosticNavigate={onDiagnosticNavigate}
          completion={completion}
          onCompletionAccept={onCompletionAccept}
          onCompletionDismiss={onCompletionDismiss}
        />
        <SyntaxAnalysisControl
          mode={syntaxMode}
          state={syntaxState}
          onModeChange={onSyntaxModeChange}
        />
      </main>
      <div
        ref={consoleResizerRef}
        className="console-resizer"
        role="separator"
        aria-label={t('console.resize')}
        aria-keyshortcuts="Control+Backquote"
        aria-controls="console-panel"
        aria-hidden={!consoleVisible}
        hidden={!consoleVisible || playgroundRows.compactKeyboard}
        aria-orientation="horizontal"
        aria-valuemin={consoleHeightBounds.min}
        aria-valuemax={consoleHeightBounds.max}
        aria-valuenow={consoleHeight}
        aria-valuetext={t('console.heightPixels', { height: consoleHeight })}
        tabIndex={0}
        onPointerDown={onConsoleResizePointerDown}
        onPointerMove={onConsoleResizePointerMove}
        onPointerUp={event => finishConsoleResize(event, true)}
        onPointerCancel={event => finishConsoleResize(event, false)}
        onLostPointerCapture={event => finishConsoleResize(event, false)}
        onKeyDown={onConsoleResizeKeyDown}
      />
      <ConsolePanel
        ref={consolePanelRef}
        id="console-panel"
        ariaKeyshortcuts="Control+Backquote"
        hidden={!consoleVisible}
        visible={consoleVisible}
        inputResetKey={inputResetKey}
        statusLabel={consoleStatusLabel}
        statusTone={consoleStatusTone}
        segments={consoleSegments}
        diagnosticFiles={diagnosticFiles}
        diagnosticSnapshot={diagnosticSnapshot}
        onDiagnosticNavigate={onDiagnosticNavigate}
        inputRequestId={inputRequestId}
        onSendStdinLine={onSendStdinLine}
        onSendStdinEOF={onSendStdinEOF}
        actions={timeoutReport && (
          <>
            <Button
              className={`console-diagnostics-copy-button${copyFeedback ? ` is-${copyFeedback}` : ''}`}
              variant="ghost"
              size="sm"
              type="button"
              aria-label={t('timeout.copyLabel')}
              title={copyFeedback === 'failed'
                ? t('timeout.copyFailed')
                : copyFeedback === 'copied' ? t('timeout.copied') : t('timeout.copyLabel')}
              onClick={onCopyTimeoutReport}
            >
              {copyFeedback === 'copied' ? t('timeout.copiedShort') : copyFeedback === 'failed' ? t('timeout.failedShort') : t('timeout.copy')}
            </Button>
            <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
              {copyFeedback === 'copied'
                ? t('timeout.copied')
                : copyFeedback === 'failed' ? t('timeout.copyFailed') : ''}
            </span>
          </>
        )}
        scrollKey={`${consoleHeight}:${viewportRect.height}`}
        onInputFocus={measureVisibleViewport}
        onInputBlur={measureVisibleViewport}
      />
      <footer className="footer">
        <div className="footer-links">
          <ExecutionSettings
            value={executionSettings}
            playbackIntervalMs={playbackIntervalMs}
            onApply={onApplyExecutionSettings}
            onPlaybackIntervalChange={onPlaybackIntervalChange}
            onLoadDebugExample={onLoadDebugExample}
            debugExampleDisabled={debugExampleDisabled}
          />
          <a
            className="github-link"
            href={GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('github.viewProject')}
            title={t('github.viewProjectTitle')}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
          {buildCommit ? (
            <a
              className="footer-commit"
              href={`${GITHUB_REPOSITORY_URL}/commit/${buildCommit}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('build.viewCommit', { commit: buildCommit })}
              title={t('build.commitTitle', { commit: buildCommit })}
            >
              {buildCommit.slice(0, 7)}
            </a>
          ) : (
            <span className="footer-commit footer-commit-local" title={t('build.local')}>
              local
            </span>
          )}
        </div>
        <span className="footer-cursor">{t('editor.cursorPosition', { line: cursor.line, column: cursor.column })}</span>
      </footer>
      {!persistenceLocked && fileDrop.target !== null && (
        <div className={`file-drop-indicator file-drop-indicator--${fileDrop.target}`} role="status" aria-live="polite" aria-atomic="true">
          <svg className="file-drop-indicator__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3.5 2.5h5l3 3v8h-8zM8.5 2.5v3h3M8 7v4m-1.5-1.5L8 11l1.5-1.5" />
          </svg>
          <span className="file-drop-indicator__copy">
            <span>{t('fileDrop.dropHint')}</span>
            {fileDrop.target === 'page' && <span className="file-drop-indicator__detail">{t('fileDrop.dropTargetHint')}</span>}
          </span>
        </div>
      )}
      <FileDropNotice notice={fileDrop.notice} onDismiss={fileDrop.onDismissNotice} />
      {memoryViewerDocument !== null && (
        <MemoryViewer
          document={memoryViewerDocument}
          configuration={executionConfiguration}
          playbackIntervalMs={playbackIntervalMs}
          onClose={closeMemoryViewer}
        />
      )}
    </div>
  );
}

export function WorkspacePersistenceNotice() {
  const { t } = useI18n();
  return (
    <div className="workspace-persistence-notice" role="status" aria-live="polite">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.8 14.3 13H1.7L8 1.8Z" />
        <path d="M8 5.3v3.4m0 2.1h.01" />
      </svg>
      <span>{t('workspace.unsupportedFormat')}</span>
    </div>
  );
}
