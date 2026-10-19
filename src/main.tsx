import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createEditorSourcePersister, readEditorSource } from './editor/sourcePersistence.ts';
import { projectEditorDiagnosticGroups } from './editor/editorDiagnostics.ts';
import { readSyntaxAnalysisMode, writeSyntaxAnalysisMode } from './editor/syntaxAnalysisPreference.ts';
import type { SyntaxAnalysisController } from './editor/syntaxAnalysisController.ts';
import { useCodeEditor } from './editor/useCodeEditor.ts';
import { useSyntaxAnalysis } from './editor/useSyntaxAnalysis.ts';
import { createRunConfiguration, readExecutionSettings, writeExecutionSettings } from './execution/settings.ts';
import type { ExecutionSettings as ExecutionSettingsValue } from './execution/settings.ts';
import { formatConsoleSegments, getConsoleStatus, useRunner } from './execution/useRunner.ts';
import { copyReportText } from './execution/copyReport.ts';
import { formatTimeoutDiagnosticsReport, readTimeoutBrowserContext } from './execution/diagnosticsReport.ts';
import type { TimeoutBrowserContext } from './execution/diagnosticsReport.ts';
import {
  DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS,
  readMemoryViewerPlaybackInterval,
  writeMemoryViewerPlaybackInterval,
} from './memory/playbackSpeed.ts';
import type { MemoryViewerPlaybackInterval } from './memory/playbackSpeed.ts';
import { getPlaygroundShortcut, isMacPlatform } from './keyboardShortcuts.ts';
import { LanguageProvider, useI18n } from './i18n.tsx';
import type { TranslationKey } from './i18n/en.ts';
import initialSource from './examples/main.c?raw';
import { PlaygroundShell } from './application/PlaygroundShell.tsx';
import { useColorTheme } from './application/useColorTheme.ts';
import { useConsoleLayout } from './application/useConsoleLayout.ts';
import './style.css';

const RUN_STOP_LABEL_DELAY_MS = 200;

function useStopLabelPhase(isRunning: boolean) {
  const [stopLabelReady, setStopLabelReady] = useState(false);

  useLayoutEffect(() => {
    setStopLabelReady(false);
    if (!isRunning) return;

    let current = true;
    const timer = window.setTimeout(() => {
      if (current) setStopLabelReady(true);
    }, RUN_STOP_LABEL_DELAY_MS);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [isRunning]);

  return isRunning && stopLabelReady;
}

function Playground() {
  const { t } = useI18n();
  const theme = useColorTheme();
  const [executionSettings, setExecutionSettings] = useState<ExecutionSettingsValue>(
    () => readExecutionSettings(() => window.localStorage),
  );
  const [memoryViewerPlaybackIntervalMs, setMemoryViewerPlaybackIntervalMs] = useState<MemoryViewerPlaybackInterval>(
    () => readMemoryViewerPlaybackInterval(() => window.localStorage, DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS),
  );
  const executionConfiguration = useMemo(() => createRunConfiguration(executionSettings), [executionSettings]);
  const [editorInitialSource] = useState(() => readEditorSource(() => window.localStorage, initialSource));
  const persistEditorSource = useMemo(
    () => createEditorSourcePersister(editorInitialSource, () => window.localStorage),
    [editorInitialSource],
  );
  const syntaxAnalysisControllerRef = useRef<SyntaxAnalysisController | null>(null);
  const persistAndInvalidateSyntax = useCallback((source: string) => {
    persistEditorSource(source);
    syntaxAnalysisControllerRef.current?.setSource(source);
  }, [persistEditorSource]);
  const updateSyntaxComposition = useCallback((composing: boolean) => {
    syntaxAnalysisControllerRef.current?.setComposing(composing);
  }, []);
  const [syntaxAnalysisMode, setSyntaxAnalysisMode] = useState(
    () => readSyntaxAnalysisMode(() => window.localStorage),
  );
  const {
    ref, cursor, text, limitMessage, isComposing, completion, acceptCompletion, dismissCompletion,
  } = useCodeEditor(
    editorInitialSource,
    persistAndInvalidateSyntax,
    {
      onCompositionChange: updateSyntaxComposition,
      completionEnabled: syntaxAnalysisMode === 'syntax',
    },
  );
  const syntaxAnalysis = useSyntaxAnalysis({
    source: text,
    enabled: syntaxAnalysisMode === 'syntax',
    composing: isComposing,
    options: executionConfiguration.options.prepare ?? {},
    timeoutMs: executionConfiguration.timeoutMs,
  }, syntaxAnalysisControllerRef);
  const editorDiagnostics = useMemo(() => {
    if (syntaxAnalysisMode !== 'syntax' || isComposing || syntaxAnalysis.status !== 'analysis-errors') return [];
    return projectEditorDiagnosticGroups(text, syntaxAnalysis.diagnostics, 'main.c');
  }, [isComposing, syntaxAnalysis, syntaxAnalysisMode, text]);
  const { state, run, stop, sendStdinLine, sendStdinEOF, isRunning } = useRunner();
  const timeoutReport = state.status === 'timeout' ? state.diagnosticsReport : null;
  const timeoutReportRef = useRef(timeoutReport);
  timeoutReportRef.current = timeoutReport;
  const timeoutContextRef = useRef<{ report: typeof timeoutReport; context: TimeoutBrowserContext | null }>({
    report: null,
    context: null,
  });
  if (timeoutContextRef.current.report !== timeoutReport) {
    timeoutContextRef.current = {
      report: timeoutReport,
      context: timeoutReport ? readTimeoutBrowserContext() : null,
    };
  }
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'failed' | null>(null);
  const copyFeedbackTimer = useRef<number | null>(null);
  const memoryViewerButtonRef = useRef<HTMLButtonElement>(null);
  const [memoryViewerSource, setMemoryViewerSource] = useState<string | null>(null);
  const memoryViewerOpen = memoryViewerSource !== null;
  const showStop = useStopLabelPhase(isRunning);
  const consoleLayout = useConsoleLayout(ref);
  const shouldFocusConsoleAfterRun = useRef(false);
  const runConsoleResetKey = useRef(0);
  const consoleStatus = getConsoleStatus(state);
  const consoleStatusKey: TranslationKey = `console.status.${consoleStatus.key}`;
  const consoleStatusLabel = t(consoleStatusKey);
  const inputRequestId = state.status === 'running' ? state.inputRequestId : null;
  const consoleSegments = useMemo(() => formatConsoleSegments(state), [state]);

  useEffect(() => {
    document.title = t('app.documentTitle');
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', t('app.description'));
  }, [t]);

  useEffect(() => {
    writeExecutionSettings(() => window.localStorage, executionSettings);
  }, [executionSettings]);

  useEffect(() => {
    writeMemoryViewerPlaybackInterval(() => window.localStorage, memoryViewerPlaybackIntervalMs);
  }, [memoryViewerPlaybackIntervalMs]);

  useEffect(() => {
    writeSyntaxAnalysisMode(() => window.localStorage, syntaxAnalysisMode);
  }, [syntaxAnalysisMode]);

  useEffect(() => {
    setCopyFeedback(null);
    if (copyFeedbackTimer.current !== null) {
      window.clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = null;
    }
    return () => {
      if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
    };
  }, [timeoutReport]);

  const copyTimeoutReport = useCallback(async () => {
    if (!timeoutReport) return;
    let copied = false;
    try {
      const browserContext = timeoutContextRef.current.context ?? readTimeoutBrowserContext();
      copied = await copyReportText(formatTimeoutDiagnosticsReport(timeoutReport, browserContext));
    } catch {
      copied = false;
    }
    if (timeoutReportRef.current !== timeoutReport) return;

    setCopyFeedback(copied ? 'copied' : 'failed');
    if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = window.setTimeout(() => {
      if (timeoutReportRef.current === timeoutReport) setCopyFeedback(null);
      copyFeedbackTimer.current = null;
    }, 2400);
  }, [timeoutReport]);

  const onRun = useCallback(() => {
    if (isRunning) stop();
    else {
      runConsoleResetKey.current++;
      shouldFocusConsoleAfterRun.current = true;
      consoleLayout.setConsoleVisible(true);
      run(new File([ref.current?.value ?? ''], 'main.c', { type: 'text/x-c' }), executionConfiguration);
    }
  }, [consoleLayout.setConsoleVisible, executionConfiguration, isRunning, ref, run, stop]);

  const openMemoryViewer = useCallback(() => {
    setMemoryViewerSource(ref.current?.value ?? text);
  }, [ref, text]);

  const closeMemoryViewer = useCallback(() => {
    setMemoryViewerSource(null);
    window.requestAnimationFrame(() => {
      memoryViewerButtonRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useLayoutEffect(() => {
    if (!shouldFocusConsoleAfterRun.current || !consoleLayout.consoleVisible || !isRunning) return;
    shouldFocusConsoleAfterRun.current = false;
    consoleLayout.consolePanelRef.current?.focus({ preventScroll: true });
  }, [consoleLayout.consoleVisible, isRunning]);

  useEffect(() => {
    const macOS = isMacPlatform();
    function onGlobalKeyDown(event: KeyboardEvent) {
      if (memoryViewerOpen) return;
      const shortcut = getPlaygroundShortcut(event, macOS);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === 'toggle-run') onRun();
      else consoleLayout.toggleConsole();
    }

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [consoleLayout.toggleConsole, memoryViewerOpen, onRun]);

  return (
    <PlaygroundShell
      theme={{ colorTheme: theme.colorTheme, onChange: theme.changeColorTheme }}
      memoryViewer={{
        buttonRef: memoryViewerButtonRef,
        open: memoryViewerOpen,
        source: memoryViewerSource,
        configuration: executionConfiguration,
        onOpen: openMemoryViewer,
        onClose: closeMemoryViewer,
      }}
      run={{ isRunning, showStop, onRun }}
      editor={{
        ref,
        text,
        initialText: editorInitialSource,
        cursor,
        limitMessage,
        diagnostics: editorDiagnostics,
        completion,
        onCompletionAccept: acceptCompletion,
        onCompletionDismiss: dismissCompletion,
        syntaxMode: syntaxAnalysisMode,
        syntaxState: syntaxAnalysis,
        onSyntaxModeChange: setSyntaxAnalysisMode,
      }}
      console={{
        layout: consoleLayout,
        statusLabel: consoleStatusLabel,
        statusTone: consoleStatus.tone,
        segments: consoleSegments,
        inputRequestId,
        inputResetKey: runConsoleResetKey.current,
        onSendStdinLine: sendStdinLine,
        onSendStdinEOF: sendStdinEOF,
        timeoutReport,
        copyFeedback,
        onCopyTimeoutReport: copyTimeoutReport,
      }}
      footer={{
        executionSettings,
        playbackIntervalMs: memoryViewerPlaybackIntervalMs,
        onApplyExecutionSettings: setExecutionSettings,
        onPlaybackIntervalChange: setMemoryViewerPlaybackIntervalMs,
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <Playground />
    </LanguageProvider>
  </StrictMode>,
);
