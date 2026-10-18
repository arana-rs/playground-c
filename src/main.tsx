import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Button, ButtonSpinner } from './components/arc/button/button.tsx';
import { ConsolePanel } from './components/ConsolePanel.tsx';
import { LanguageSwitch } from './components/LanguageSwitch.tsx';
import { ThemeSwitch } from './components/arc/theme-switch/theme-switch.tsx';
import { SelectedFileTab } from './components/SelectedFileTab.tsx';
import { CodeEditor } from './editor/CodeEditor.tsx';
import { createEditorSourcePersister, readEditorSource } from './editor/sourcePersistence.ts';
import { useCodeEditor } from './editor/useCodeEditor.ts';
import { formatConsoleSegments, getConsoleStatus, useRunner } from './execution/useRunner.ts';
import { copyReportText } from './execution/copyReport.ts';
import { formatTimeoutDiagnosticsReport, readTimeoutBrowserContext } from './execution/diagnosticsReport.ts';
import type { TimeoutBrowserContext } from './execution/diagnosticsReport.ts';
import { MemoryViewer } from './memory/MemoryViewer.tsx';
import {
  clampConsoleHeight,
  getConsoleHeightBounds,
  getEffectiveConsoleHeight,
  getInitialConsoleHeight,
  getPlaygroundRows,
  getVisibleViewportRect,
  hasKeyboardViewportRecovered,
  isKeyboardViewportShrunk,
} from './consoleLayout.ts';
import { getPlaygroundShortcut, isMacPlatform } from './keyboardShortcuts.ts';
import { LanguageProvider, useI18n } from './i18n.tsx';
import type { TranslationKey } from './i18n/en.ts';
import initialSource from './examples/main.c?raw';
import './style.css';

const RUN_STOP_LABEL_DELAY_MS = 200;
const CONSOLE_RESIZE_STEP = 16;
const THEME_SWEEP_DURATION_MS = 640;
const COLOR_THEME_STORAGE_KEY = 'c-playground-color-theme';
const GITHUB_REPOSITORY_URL = 'https://github.com/arana-rs/playground-c';
const buildCommit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';

type ColorTheme = 'github-dark' | 'github-light';

interface SameDocumentViewTransition {
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => SameDocumentViewTransition;
};

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function readColorTheme(): ColorTheme {
  try {
    return window.localStorage.getItem(COLOR_THEME_STORAGE_KEY) === 'github-light'
      ? 'github-light'
      : 'github-dark';
  } catch {
    return 'github-dark';
  }
}

const initialColorTheme = readColorTheme();
document.documentElement.dataset.theme = initialColorTheme;

interface ConsoleResizeDrag {
  pointerId: number;
  startY: number;
  startHeight: number;
}

interface PendingConsoleHeight {
  drag: ConsoleResizeDrag;
  height: number;
}

function readVisibleViewportRect() {
  const visualViewport = window.visualViewport;
  return getVisibleViewportRect(
    window.innerWidth,
    window.innerHeight,
    visualViewport ? {
      width: visualViewport.width,
      height: visualViewport.height,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
      scale: visualViewport.scale,
    } : undefined,
  );
}

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
  const [colorTheme, setColorTheme] = useState<ColorTheme>(initialColorTheme);
  const requestedColorTheme = useRef(colorTheme);
  const themeTransitionGeneration = useRef(0);
  const [editorInitialSource] = useState(() => readEditorSource(() => window.localStorage, initialSource));
  const persistEditorSource = useMemo(
    () => createEditorSourcePersister(editorInitialSource, () => window.localStorage),
    [editorInitialSource],
  );
  const { ref, cursor, text, limitMessage } = useCodeEditor(editorInitialSource, persistEditorSource);
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
  const [viewportRect, setViewportRect] = useState(() => readVisibleViewportRect());
  const [preferredConsoleHeight, setPreferredConsoleHeight] = useState(() => getInitialConsoleHeight(readVisibleViewportRect().height));
  const [keyboardViewportActive, setKeyboardViewportActive] = useState(false);
  const [keyboardHeightManuallyAdjusted, setKeyboardHeightManuallyAdjusted] = useState(false);
  const [consoleVisible, setConsoleVisible] = useState(true);
  const [isResizingConsole, setIsResizingConsole] = useState(false);
  const consoleResizeDrag = useRef<ConsoleResizeDrag | null>(null);
  const pendingConsoleHeight = useRef<PendingConsoleHeight | null>(null);
  const consoleResizeFrame = useRef<number | null>(null);
  const viewportRectRef = useRef(viewportRect);
  const viewportBaseline = useRef({ width: viewportRect.width, height: viewportRect.height });
  const keyboardViewportActiveRef = useRef(false);
  const consoleResizerRef = useRef<HTMLDivElement>(null);
  const consolePanelRef = useRef<HTMLElement>(null);
  const shouldFocusConsoleAfterRun = useRef(false);
  const runConsoleResetKey = useRef(0);
  const consoleHeightBounds = getConsoleHeightBounds(viewportRect.height, keyboardViewportActive, consoleVisible);
  const consoleHeight = getEffectiveConsoleHeight(
    preferredConsoleHeight,
    viewportRect.height,
    keyboardViewportActive,
    keyboardHeightManuallyAdjusted,
    consoleVisible,
  );
  const playgroundRows = getPlaygroundRows(viewportRect.height, keyboardViewportActive, consoleVisible);
  const consoleStatus = getConsoleStatus(state);
  const consoleStatusKey: TranslationKey = `console.status.${consoleStatus.key}`;
  const consoleStatusLabel = t(consoleStatusKey);
  const inputRequestId = state.status === 'running' ? state.inputRequestId : null;
  const consoleSegments = useMemo(() => formatConsoleSegments(state), [state]);

  useEffect(() => {
    document.title = t('app.documentTitle');
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', t('app.description'));
  }, [t]);

  useLayoutEffect(() => {
    requestedColorTheme.current = colorTheme;
    document.documentElement.dataset.theme = colorTheme;
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, colorTheme);
    } catch {
      // Theme selection remains available when storage is disabled or full.
    }
  }, [colorTheme]);

  const changeColorTheme = useCallback((next: 'light' | 'dark', trigger: HTMLButtonElement) => {
    const requestedTheme = requestedColorTheme.current === colorTheme
      ? next === 'light' ? 'github-light' : 'github-dark'
      : requestedColorTheme.current === 'github-dark' ? 'github-light' : 'github-dark';
    if (requestedTheme === requestedColorTheme.current) return;
    requestedColorTheme.current = requestedTheme;

    const commitRequestedTheme = () => {
      flushSync(() => setColorTheme(requestedColorTheme.current));
    };
    const root = document.documentElement;
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewTransitionDocument = document as ViewTransitionDocument;
    const startViewTransition = viewTransitionDocument.startViewTransition;

    if (!reducedMotion && typeof startViewTransition === 'function') {
      const bounds = trigger.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const width = root.clientWidth || window.innerWidth;
      const height = root.clientHeight || window.innerHeight;
      const radius = Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y)));
      const generation = ++themeTransitionGeneration.current;
      const clearSweepOrigin = () => {
        if (generation !== themeTransitionGeneration.current) return;
        root.style.removeProperty('--theme-sweep-duration');
        root.style.removeProperty('--theme-sweep-x');
        root.style.removeProperty('--theme-sweep-y');
        root.style.removeProperty('--theme-sweep-radius');
      };

      root.style.setProperty('--theme-sweep-duration', `${THEME_SWEEP_DURATION_MS}ms`);
      root.style.setProperty('--theme-sweep-x', `${x}px`);
      root.style.setProperty('--theme-sweep-y', `${y}px`);
      root.style.setProperty('--theme-sweep-radius', `${radius}px`);

      try {
        const transition = startViewTransition.call(document, commitRequestedTheme);
        void transition.ready.catch(error => {
          if (!isAbortError(error)) console.error('Could not prepare the theme transition.', error);
        });
        void transition.updateCallbackDone.catch(error => {
          if (!isAbortError(error)) console.error('Could not apply the theme during the transition.', error);
          try {
            commitRequestedTheme();
          } catch (commitError) {
            clearSweepOrigin();
            console.error('Could not apply the theme after the transition failed.', commitError);
          }
        });
        void transition.finished.then(clearSweepOrigin, error => {
          clearSweepOrigin();
          if (!isAbortError(error)) console.error('The theme transition failed.', error);
        });
        return;
      } catch (error) {
        clearSweepOrigin();
        console.error('Could not start the theme transition.', error);
      }
    }

    commitRequestedTheme();
  }, [colorTheme]);

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

  const cancelPendingConsoleResize = useCallback(() => {
    if (consoleResizeFrame.current !== null) {
      window.cancelAnimationFrame(consoleResizeFrame.current);
    }
    consoleResizeFrame.current = null;
    pendingConsoleHeight.current = null;
  }, []);

  const measureVisibleViewport = useCallback(() => {
    const nextViewport = readVisibleViewportRect();
    const previousViewport = viewportRectRef.current;
    const dimensionsChanged = Math.abs(nextViewport.width - previousViewport.width) > 0.5
      || Math.abs(nextViewport.height - previousViewport.height) > 0.5;
    const rectChanged = dimensionsChanged
      || Math.abs(nextViewport.left - previousViewport.left) > 0.5
      || Math.abs(nextViewport.top - previousViewport.top) > 0.5
      || Math.abs(nextViewport.scale - previousViewport.scale) > 0.01;

    if (rectChanged) {
      viewportRectRef.current = nextViewport;
      setViewportRect(nextViewport);
    }
    if (dimensionsChanged) cancelPendingConsoleResize();

    const baseline = viewportBaseline.current;
    const sample = {
      width: nextViewport.width,
      height: nextViewport.height,
      referenceWidth: baseline.width,
      referenceHeight: baseline.height,
      scale: nextViewport.scale,
      stdinFocused: document.activeElement instanceof HTMLElement
        && document.activeElement.classList.contains('console-stdin'),
    };

    if (keyboardViewportActiveRef.current) {
      if (hasKeyboardViewportRecovered(sample)) {
        keyboardViewportActiveRef.current = false;
        setKeyboardViewportActive(false);
        setKeyboardHeightManuallyAdjusted(false);
        viewportBaseline.current = { width: nextViewport.width, height: nextViewport.height };
      }
    } else if (sample.stdinFocused) {
      if (isKeyboardViewportShrunk(sample)) {
        keyboardViewportActiveRef.current = true;
        setKeyboardViewportActive(true);
      } else if (hasKeyboardViewportRecovered(sample)) {
        viewportBaseline.current = { width: nextViewport.width, height: nextViewport.height };
      }
    } else {
      viewportBaseline.current = { width: nextViewport.width, height: nextViewport.height };
    }
  }, [cancelPendingConsoleResize]);

  useLayoutEffect(() => {
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', measureVisibleViewport);
    visualViewport?.addEventListener('resize', measureVisibleViewport);
    visualViewport?.addEventListener('scroll', measureVisibleViewport);
    measureVisibleViewport();
    return () => {
      window.removeEventListener('resize', measureVisibleViewport);
      visualViewport?.removeEventListener('resize', measureVisibleViewport);
      visualViewport?.removeEventListener('scroll', measureVisibleViewport);
    };
  }, [measureVisibleViewport]);

  useEffect(() => () => {
    // Removing the separator releases any pointer capture held by its DOM node.
    cancelPendingConsoleResize();
    consoleResizeDrag.current = null;
  }, [cancelPendingConsoleResize]);

  const onRun = useCallback(() => {
    if (isRunning) stop();
    else {
      runConsoleResetKey.current++;
      shouldFocusConsoleAfterRun.current = true;
      setConsoleVisible(true);
      run(new File([ref.current?.value ?? ''], 'main.c', { type: 'text/x-c' }));
    }
  }, [isRunning, ref, run, stop]);

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
    if (!shouldFocusConsoleAfterRun.current || !consoleVisible || !isRunning) return;
    shouldFocusConsoleAfterRun.current = false;
    consolePanelRef.current?.focus({ preventScroll: true });
  }, [consoleVisible, isRunning]);

  const toggleConsole = useCallback(() => {
    if (consoleVisible) {
      const resizer = consoleResizerRef.current;
      const panel = consolePanelRef.current;
      const activeElement = document.activeElement;
      if (resizer?.contains(activeElement) || panel?.contains(activeElement)) {
        const editor = ref.current;
        if (editor) {
          const selectionStart = editor.selectionStart;
          const selectionEnd = editor.selectionEnd;
          const selectionDirection = editor.selectionDirection;
          const scrollTop = editor.scrollTop;
          const scrollLeft = editor.scrollLeft;
          editor.focus({ preventScroll: true });
          editor.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
          editor.scrollTop = scrollTop;
          editor.scrollLeft = scrollLeft;
        }
      }

      cancelPendingConsoleResize();
      const drag = consoleResizeDrag.current;
      consoleResizeDrag.current = null;
      if (drag && resizer?.hasPointerCapture(drag.pointerId)) {
        resizer.releasePointerCapture(drag.pointerId);
      }
      setIsResizingConsole(false);
    }
    setConsoleVisible(visible => !visible);
  }, [cancelPendingConsoleResize, consoleVisible, ref]);

  useEffect(() => {
    const macOS = isMacPlatform();
    function onGlobalKeyDown(event: KeyboardEvent) {
      if (memoryViewerOpen) return;
      const shortcut = getPlaygroundShortcut(event, macOS);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === 'toggle-run') onRun();
      else toggleConsole();
    }

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [memoryViewerOpen, onRun, toggleConsole]);

  function onConsoleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (consoleResizeDrag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    cancelPendingConsoleResize();
    consoleResizeDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: consoleHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingConsole(true);
  }

  function onConsoleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = consoleResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (keyboardViewportActive) setKeyboardHeightManuallyAdjusted(true);
    const nextHeight = drag.startHeight + drag.startY - event.clientY;
    pendingConsoleHeight.current = {
      drag,
      height: clampConsoleHeight(nextHeight, getConsoleHeightBounds(viewportRect.height, keyboardViewportActive, consoleVisible)),
    };
    if (consoleResizeFrame.current !== null) return;
    consoleResizeFrame.current = window.requestAnimationFrame(() => {
      consoleResizeFrame.current = null;
      const pending = pendingConsoleHeight.current;
      pendingConsoleHeight.current = null;
      if (!pending || consoleResizeDrag.current !== pending.drag) return;
      setPreferredConsoleHeight(pending.height);
    });
  }

  function finishConsoleResize(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const drag = consoleResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (commit) {
      const finalHeight = drag.startHeight + drag.startY - event.clientY;
      cancelPendingConsoleResize();
      setPreferredConsoleHeight(clampConsoleHeight(finalHeight, getConsoleHeightBounds(viewportRect.height, keyboardViewportActive, consoleVisible)));
    } else {
      cancelPendingConsoleResize();
    }
    consoleResizeDrag.current = null;
    setIsResizingConsole(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (commit && keyboardViewportActive) setKeyboardHeightManuallyAdjusted(true);
  }

  function onConsoleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextHeight: number | undefined;
    const step = event.shiftKey ? CONSOLE_RESIZE_STEP * 3 : CONSOLE_RESIZE_STEP;
    if (event.key === 'ArrowUp') nextHeight = consoleHeight + step;
    else if (event.key === 'ArrowDown') nextHeight = consoleHeight - step;
    else if (event.key === 'Home') nextHeight = consoleHeightBounds.min;
    else if (event.key === 'End') nextHeight = consoleHeightBounds.max;
    if (nextHeight === undefined) return;
    event.preventDefault();
    if (keyboardViewportActive) setKeyboardHeightManuallyAdjusted(true);
    setPreferredConsoleHeight(clampConsoleHeight(nextHeight, consoleHeightBounds));
  }

  const playgroundStyle: CSSProperties = {
    top: viewportRect.top,
    left: viewportRect.left,
    width: viewportRect.width,
    height: viewportRect.height,
    gridTemplateRows: `${playgroundRows.header}px ${playgroundRows.tabs}px minmax(${playgroundRows.editorMinimum}px, 1fr) ${playgroundRows.separator}px ${consoleVisible ? consoleHeight : 0}px ${playgroundRows.footer}px`,
  };

  return (
    <div className={`playground${isResizingConsole ? ' is-resizing-console' : ''}${playgroundRows.compactKeyboard ? ' is-keyboard-compact' : ''}`} style={playgroundStyle}>
      <header className="header">
        <span>Playground for C</span>
        <div className="header-actions">
          <ThemeSwitch
            className="theme-toggle-button"
            theme={colorTheme === 'github-dark' ? 'dark' : 'light'}
            label={t(colorTheme === 'github-dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
            title={t(colorTheme === 'github-dark' ? 'theme.switchToLight' : 'theme.switchToDark')}
            onThemeChange={changeColorTheme}
          />
          <LanguageSwitch />
          <Button
            ref={memoryViewerButtonRef}
            className="memory-viewer-open-button"
            variant="secondary"
            size="sm"
            type="button"
            aria-label={t('memoryViewer.open')}
            aria-haspopup="dialog"
            aria-expanded={memoryViewerOpen}
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
      </header>
      <div className="file-tabs">
        <SelectedFileTab fileName="main.c" />
        <Button
          className="run-button"
          variant="secondary"
          size="sm"
          type="button"
          aria-keyshortcuts={`${isMacPlatform() ? 'Meta' : 'Control'}+Enter`}
          aria-busy={isRunning || undefined}
          aria-label={t(isRunning ? 'run.stop' : 'run.label')}
          aria-description={isRunning ? t('run.stopDescription') : undefined}
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
      </div>
      <main className="editor-pane">
        <CodeEditor
          editorRef={ref}
          text={text}
          initialText={editorInitialSource}
          activeLine={cursor.line}
          limitMessage={limitMessage}
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
        inputResetKey={runConsoleResetKey.current}
        statusLabel={consoleStatusLabel}
        statusTone={consoleStatus.tone}
        segments={consoleSegments}
        inputRequestId={inputRequestId}
        onSendStdinLine={sendStdinLine}
        onSendStdinEOF={sendStdinEOF}
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
              onClick={copyTimeoutReport}
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
      {memoryViewerSource !== null && (
        <MemoryViewer source={memoryViewerSource} onClose={closeMemoryViewer} />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <Playground />
    </LanguageProvider>
  </StrictMode>,
);
