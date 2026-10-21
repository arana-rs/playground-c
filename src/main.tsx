import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createWorkspaceWriteAdmission,
  createWorkspacePersister,
  handleWorkspaceStorageChange,
  getActiveWorkspaceFile,
  getNextWorkspaceFileName,
  getWorkspaceFileNameError,
  guardWorkspaceMutation,
  addWorkspaceFile,
  deleteWorkspaceFile,
  readWorkspaceState,
  renameWorkspaceFile,
  selectWorkspaceFile,
  updateWorkspaceFileSource,
  runAfterWorkspaceCommit,
} from './editor/sourcePersistence.ts';
import type { Workspace, WorkspacePersistenceStatus } from './editor/sourcePersistence.ts';
import {
  addPreparedDroppedSource,
  isFileTransfer,
  preflightDroppedFiles,
  readDroppedSource,
} from './editor/fileDropImport.ts';
import type { FileDropImportRejection, FileDropTarget } from './editor/fileDropImport.ts';
import { createExecutionDocumentSnapshot } from './execution/documentSnapshot.ts';
import { createWorkspaceSourceSnapshot } from './execution/documentSnapshot.ts';
import type { WorkspaceSourceSnapshot } from './execution/documentSnapshot.ts';
import { isRunnableBuildPlan, resolveBuildPlan } from './build/buildPlan.ts';
import { projectEditorDiagnosticGroups, resolveEditorSourceLocation } from './editor/editorDiagnostics.ts';
import type { EditorSourceLocationTarget } from './editor/editorDiagnostics.ts';
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
import type { FileDropNoticeState } from './components/FileDropNotice.tsx';
import { MAX_EDITOR_LINES } from './editor/limits.ts';
import initialSource from './examples/main.c?raw';
import debugExampleSource from './examples/debug.c?raw';
import { PlaygroundShell } from './application/PlaygroundShell.tsx';
import type { DiagnosticNavigationOutcome } from './components/DiagnosticLocationAction.tsx';
import { useColorTheme } from './application/useColorTheme.ts';
import { useConsoleLayout } from './application/useConsoleLayout.ts';
import './style.css';

const RUN_STOP_LABEL_DELAY_MS = 200;

const fileDropMessageKeys: Record<FileDropImportRejection, TranslationKey> = {
  'multiple-files': 'fileDrop.multipleFiles',
  'unsupported-extension': 'fileDrop.unsupportedExtension',
  'invalid-name': 'fileDrop.invalidName',
  'duplicate-name': 'fileDrop.duplicateName',
  'file-too-large': 'fileDrop.fileTooLarge',
  'too-many-lines': 'fileDrop.tooManyLines',
  'invalid-utf8': 'fileDrop.invalidUtf8',
  'contains-nul': 'fileDrop.containsNul',
  'read-failed': 'fileDrop.readFailed',
  'file-id-conflict': 'fileDrop.fileIdConflict',
};

function createWorkspaceFileId(workspace: Workspace): string {
  const randomPart = typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const baseId = `file-${randomPart}`;
  let id = baseId;
  let suffix = 2;
  while (workspace.files.some(file => file.id === id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function getFileDropTarget(target: EventTarget | null, root: HTMLElement): FileDropTarget | null {
  if (!(target instanceof Node) || !root.contains(target)) return null;
  const element = target instanceof Element ? target : target.parentElement;
  const zone = element?.closest<HTMLElement>('[data-file-drop-zone]');
  if (!zone || !root.contains(zone)) return 'page';
  return zone.dataset.fileDropZone === 'tabs' ? 'tabs' : 'editor';
}

function hasOpenModal(root: HTMLElement): boolean {
  return root.querySelector('dialog[open], [aria-modal="true"]') !== null;
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
  const theme = useColorTheme();
  const [executionSettings, setExecutionSettings] = useState<ExecutionSettingsValue>(
    () => readExecutionSettings(() => window.localStorage),
  );
  const [memoryViewerPlaybackIntervalMs, setMemoryViewerPlaybackIntervalMs] = useState<MemoryViewerPlaybackInterval>(
    () => readMemoryViewerPlaybackInterval(() => window.localStorage, DEFAULT_MEMORY_VIEWER_PLAYBACK_INTERVAL_MS),
  );
  const executionConfiguration = useMemo(() => createRunConfiguration(executionSettings), [executionSettings]);
  const [workspaceReadState] = useState(
    () => readWorkspaceState(() => window.localStorage, initialSource),
  );
  const [workspace, setWorkspace] = useState<Workspace>(workspaceReadState.workspace);
  const [persistenceStatus, setPersistenceStatus] = useState<WorkspacePersistenceStatus>(
    workspaceReadState.persistenceStatus,
  );
  const persistenceLocked = persistenceStatus === 'unsupported-version';
  const initialWorkspaceRef = useRef(workspace);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const persistenceStatusRef = useRef(persistenceStatus);
  persistenceStatusRef.current = persistenceStatus;
  const lockUnsupportedWorkspace = useCallback(() => {
    persistenceStatusRef.current = 'unsupported-version';
    setPersistenceStatus('unsupported-version');
  }, []);
  const workspaceWriteAdmission = useMemo(
    () => createWorkspaceWriteAdmission(() => window.localStorage, lockUnsupportedWorkspace),
    [lockUnsupportedWorkspace],
  );
  const canMutateWorkspace = useCallback(() => {
    if (persistenceStatusRef.current === 'unsupported-version') return false;
    return workspaceWriteAdmission();
  }, [workspaceWriteAdmission]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      handleWorkspaceStorageChange(
        event,
        () => window.localStorage,
        workspaceWriteAdmission,
        canMutateWorkspace,
      );
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [canMutateWorkspace, workspaceWriteAdmission]);
  const [fileDropTarget, setFileDropTarget] = useState<FileDropTarget | null>(null);
  const fileDropTargetRef = useRef<FileDropTarget | null>(null);
  const [fileDropNotice, setFileDropNotice] = useState<FileDropNoticeState | null>(null);
  const nextFileDropNoticeId = useRef(0);
  const updateFileDropTarget = useCallback((target: FileDropTarget | null) => {
    fileDropTargetRef.current = target;
    setFileDropTarget(target);
  }, []);
  const showFileDropNotice = useCallback((
    messageKey: TranslationKey,
    fileName: string,
    tone: FileDropNoticeState['tone'],
    values?: FileDropNoticeState['values'],
  ) => {
    setFileDropNotice({
      id: ++nextFileDropNoticeId.current,
      fileName,
      messageKey,
      tone,
      values,
    });
  }, []);
  const dismissFileDropNotice = useCallback((id: number) => {
    setFileDropNotice(current => current?.id === id ? null : current);
  }, []);
  const requestedFile = getActiveWorkspaceFile(workspace);
  const editorSourceRef = useRef({ documentId: requestedFile.id, source: requestedFile.source });
  const syntaxAnalysisControllerRef = useRef<SyntaxAnalysisController | null>(null);
  const persistWorkspace = useMemo(
    () => createWorkspacePersister(initialWorkspaceRef.current, () => window.localStorage),
    [],
  );
  const commitWorkspace = useCallback((nextWorkspace: Workspace) => {
    if (!canMutateWorkspace()) return false;
    const previousWorkspace = workspaceRef.current;
    if (nextWorkspace === previousWorkspace) return true;
    const guardedWorkspace = guardWorkspaceMutation(
      previousWorkspace,
      nextWorkspace,
      persistenceStatusRef.current,
    );
    if (guardedWorkspace === previousWorkspace) return false;

    const persisted = persistWorkspace(nextWorkspace);
    if (!persisted && !canMutateWorkspace()) return false;

    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    const currentEditor = editorSourceRef.current;
    const isSelectingAnotherFile = nextWorkspace.activeFileId !== previousWorkspace.activeFileId;
    const currentFile = isSelectingAnotherFile
      ? undefined
      : nextWorkspace.files.find(file => file.id === currentEditor.documentId);
    const entryFile = currentFile ?? getActiveWorkspaceFile(nextWorkspace);
    const entrySource = currentFile ? currentEditor.source : entryFile.source;
    syntaxAnalysisControllerRef.current?.setSnapshot(createWorkspaceSourceSnapshot(
      createExecutionDocumentSnapshot(entryFile.id, entryFile.name, 0, entrySource),
      nextWorkspace.files,
    ));
    return persisted;
  }, [canMutateWorkspace, persistWorkspace]);
  const effectiveDocumentIdRef = useRef(workspace.activeFileId);
  const persistAndInvalidateSyntax = useCallback((documentId: string, source: string) => {
    if (!canMutateWorkspace()) return;
    const nextWorkspace = updateWorkspaceFileSource(workspaceRef.current, documentId, source);
    commitWorkspace(nextWorkspace);
    if (documentId === effectiveDocumentIdRef.current) {
      const currentWorkspace = workspaceRef.current;
      const entryFile = currentWorkspace.files.find(file => file.id === documentId);
      if (entryFile) {
        syntaxAnalysisControllerRef.current?.setSnapshot(createWorkspaceSourceSnapshot(
          createExecutionDocumentSnapshot(documentId, entryFile.name, 0, source),
          currentWorkspace.files,
        ));
      }
    }
  }, [canMutateWorkspace, commitWorkspace]);
  const updateSyntaxComposition = useCallback((composing: boolean) => {
    syntaxAnalysisControllerRef.current?.setComposing(composing);
  }, []);
  const [syntaxAnalysisMode, setSyntaxAnalysisMode] = useState(
    () => readSyntaxAnalysisMode(() => window.localStorage),
  );
  const {
    ref, cursor, text, limitMessage, isComposing, completion, acceptCompletion, dismissCompletion, replaceText,
    navigateToSourceLocation,
    activeDocumentId, captureDocumentSource, removeDocumentSession,
  } = useCodeEditor(
    workspace.activeFileId,
    requestedFile.source,
    persistAndInvalidateSyntax,
    {
      onCompositionChange: updateSyntaxComposition,
      completionEnabled: syntaxAnalysisMode === 'syntax',
      readOnly: persistenceStatus === 'unsupported-version',
      canMutate: canMutateWorkspace,
    },
  );
  effectiveDocumentIdRef.current = activeDocumentId;
  const activeFile = workspace.files.find(file => file.id === activeDocumentId) ?? requestedFile;
  editorSourceRef.current = { documentId: activeFile.id, source: text };
  const onSelectFile = useCallback((fileId: string) => {
    commitWorkspace(selectWorkspaceFile(workspaceRef.current, fileId));
  }, [commitWorkspace]);
  const loadDebugExample = useCallback(() => {
    if (!canMutateWorkspace()) return;
    const effectiveDocumentId = activeDocumentId;
    runAfterWorkspaceCommit(
      () => commitWorkspace(selectWorkspaceFile(workspaceRef.current, effectiveDocumentId)),
      () => replaceText(debugExampleSource, effectiveDocumentId),
    );
  }, [activeDocumentId, canMutateWorkspace, commitWorkspace, replaceText]);
  const onCreateFile = useCallback(() => {
    if (!canMutateWorkspace()) return null;
    const currentWorkspace = workspaceRef.current;
    const file = {
      id: createWorkspaceFileId(currentWorkspace),
      name: getNextWorkspaceFileName(currentWorkspace),
      source: '',
    };
    const nextWorkspace = addWorkspaceFile(currentWorkspace, file);
    if (nextWorkspace === currentWorkspace) return null;
    commitWorkspace(nextWorkspace);
    return file;
  }, [canMutateWorkspace, commitWorkspace]);
  const onRenameFile = useCallback((fileId: string, name: string) => {
    if (!canMutateWorkspace()) return;
    commitWorkspace(renameWorkspaceFile(workspaceRef.current, fileId, name));
  }, [canMutateWorkspace, commitWorkspace]);
  const onDeleteFile = useCallback((fileId: string) => {
    if (!canMutateWorkspace()) return;
    if (isComposing && fileId === activeDocumentId) return;
    captureDocumentSource();
    const nextWorkspace = deleteWorkspaceFile(workspaceRef.current, fileId);
    if (nextWorkspace === workspaceRef.current) return;
    removeDocumentSession(fileId);
    commitWorkspace(nextWorkspace);
  }, [activeDocumentId, canMutateWorkspace, captureDocumentSource, commitWorkspace, isComposing, removeDocumentSession]);
  const importDroppedFiles = useCallback(async (files: readonly File[]) => {
    if (!canMutateWorkspace()) return;
    const reject = (reason: FileDropImportRejection, fileName: string, lineCount?: number) => {
      if (!fileName) {
        showFileDropNotice('fileDrop.noFile', '', 'error');
        return;
      }
      showFileDropNotice(
        fileDropMessageKeys[reason],
        fileName,
        reason === 'multiple-files' ? 'warning' : 'error',
        reason === 'too-many-lines' ? { count: lineCount ?? 0, max: MAX_EDITOR_LINES } : undefined,
      );
    };

    const initialWorkspace = workspaceRef.current;
    const preflight = preflightDroppedFiles(files, initialWorkspace);
    if (preflight.status === 'rejected') {
      reject(preflight.reason, preflight.fileName);
      return;
    }

    const readResult = await readDroppedSource(preflight.value);
    if (readResult.status === 'rejected') {
      reject(readResult.reason, readResult.fileName, readResult.lineCount);
      return;
    }
    if (!canMutateWorkspace()) return;

    const currentWorkspace = workspaceRef.current;
    const currentNameError = getWorkspaceFileNameError(readResult.value.name, currentWorkspace.files);
    if (currentNameError === 'duplicate') {
      reject('duplicate-name', readResult.value.name);
      return;
    }
    if (currentNameError !== null) {
      reject('invalid-name', readResult.value.name);
      return;
    }

    const capturedSource = captureDocumentSource();
    const workspaceWithCurrentSource = updateWorkspaceFileSource(
      workspaceRef.current,
      capturedSource.documentId,
      capturedSource.source,
    );
    const added = addPreparedDroppedSource(
      workspaceWithCurrentSource,
      readResult.value,
      createWorkspaceFileId(workspaceWithCurrentSource),
    );
    if (added.status === 'rejected') {
      reject(added.reason, added.fileName);
      return;
    }

    const persisted = commitWorkspace(added.value.workspace);
    showFileDropNotice(
      persisted ? 'fileDrop.opened' : 'fileDrop.openedUnsaved',
      added.value.file.name,
      persisted ? 'success' : 'warning',
    );
  }, [canMutateWorkspace, captureDocumentSource, commitWorkspace, showFileDropNotice]);
  const onFileDragEnterCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    if (!canMutateWorkspace()) {
      updateFileDropTarget(null);
      return;
    }
    const target = getFileDropTarget(event.target, event.currentTarget);
    if (target) updateFileDropTarget(target);
  }, [canMutateWorkspace, updateFileDropTarget]);
  const onFileDragOverCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileTransfer(event.dataTransfer) && fileDropTargetRef.current === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!canMutateWorkspace()) {
      updateFileDropTarget(null);
      return;
    }
    const target = getFileDropTarget(event.target, event.currentTarget);
    if (target) updateFileDropTarget(target);
  }, [canMutateWorkspace, updateFileDropTarget]);
  const onFileDragLeaveCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    if (fileDropTargetRef.current !== null) updateFileDropTarget(null);
  }, [updateFileDropTarget]);
  const onFileDropCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    if (!canMutateWorkspace()) {
      updateFileDropTarget(null);
      return;
    }
    const target = getFileDropTarget(event.target, event.currentTarget);
    updateFileDropTarget(null);
    const files = Array.from(event.dataTransfer.files);
    const fileName = files[0]?.name ?? '';

    if (hasOpenModal(event.currentTarget)) {
      showFileDropNotice(fileName ? 'fileDrop.modalOpen' : 'fileDrop.noFile', fileName, 'warning');
      return;
    }
    if (target !== 'tabs' && target !== 'editor') {
      showFileDropNotice(fileName ? 'fileDrop.targetRequired' : 'fileDrop.noFile', fileName, 'warning');
      return;
    }
    void importDroppedFiles(files);
  }, [canMutateWorkspace, importDroppedFiles, showFileDropNotice, updateFileDropTarget]);
  const syntaxSnapshot = useMemo(() => createWorkspaceSourceSnapshot(
    createExecutionDocumentSnapshot(activeFile.id, activeFile.name, 0, text),
    workspace.files,
  ), [activeFile.id, activeFile.name, text, workspace.files]);
  const buildResolution = useMemo(
    () => resolveBuildPlan(syntaxSnapshot.files, syntaxSnapshot.fileName),
    [syntaxSnapshot],
  );
  const syntaxAnalysis = useSyntaxAnalysis({
    snapshot: syntaxSnapshot,
    enabled: syntaxAnalysisMode === 'syntax',
    composing: isComposing,
    options: executionConfiguration.options.prepare ?? {},
    timeoutMs: executionConfiguration.timeoutMs,
  }, syntaxAnalysisControllerRef);
  const diagnosticSourceSnapshot = syntaxAnalysis.status === 'analysis-errors'
    ? syntaxAnalysis.snapshot : syntaxSnapshot;
  const editorDiagnostics = useMemo(() => {
    if (syntaxAnalysisMode !== 'syntax' || isComposing || syntaxAnalysis.status !== 'analysis-errors') return [];
    return projectEditorDiagnosticGroups(text, syntaxAnalysis.diagnostics, activeFile.name, syntaxAnalysis.snapshot.files);
  }, [activeFile.name, isComposing, syntaxAnalysis, syntaxAnalysisMode, text]);
  const navigateDiagnosticLocation = useCallback((
    location: EditorSourceLocationTarget,
    capturedSnapshot: WorkspaceSourceSnapshot,
  ): DiagnosticNavigationOutcome => {
    if (!canMutateWorkspace()) return 'unavailable';
    const activeCapture = location.sourceId === effectiveDocumentIdRef.current
      ? captureDocumentSource()
      : null;
    const currentWorkspace = workspaceRef.current;
    const currentFiles = activeCapture
      ? currentWorkspace.files.map(file => file.id === activeCapture.documentId
        ? { ...file, source: activeCapture.source }
        : file)
      : currentWorkspace.files;
    const resolution = resolveEditorSourceLocation(location, currentFiles, capturedSnapshot.files);
    if (resolution.status !== 'available') return 'unavailable';

    commitWorkspace(selectWorkspaceFile(currentWorkspace, resolution.documentId));
    const navigated = navigateToSourceLocation({
      documentId: resolution.documentId,
      source: resolution.source,
      line: location.line,
      column: location.column,
    });
    if (!navigated) return 'unavailable';
    return resolution.stale ? 'stale' : 'navigated';
  }, [canMutateWorkspace, captureDocumentSource, commitWorkspace, navigateToSourceLocation]);
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
  const [memoryViewerDocument, setMemoryViewerDocument] = useState<WorkspaceSourceSnapshot | null>(null);
  const memoryViewerOpen = memoryViewerDocument !== null;
  const showStop = useStopLabelPhase(isRunning);
  const consoleLayout = useConsoleLayout(ref, persistenceLocked);
  const shouldFocusConsoleAfterRun = useRef(false);
  const runConsoleResetKey = useRef(0);
  const consoleStatus = getConsoleStatus(state);
  const consoleStatusKey: TranslationKey = `console.status.${consoleStatus.key}`;
  const consoleStatusLabel = state.status === 'idle'
    ? t(consoleStatusKey)
    : t('console.executionStatus', { status: t(consoleStatusKey), file: state.document.fileName });
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
    const preventFileNavigation = (event: DragEvent) => {
      if (isFileTransfer(event.dataTransfer)) event.preventDefault();
    };
    const clearFileDrag = () => updateFileDropTarget(null);
    window.addEventListener('dragover', preventFileNavigation, true);
    window.addEventListener('drop', preventFileNavigation, true);
    window.addEventListener('dragend', clearFileDrag, true);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation, true);
      window.removeEventListener('drop', preventFileNavigation, true);
      window.removeEventListener('dragend', clearFileDrag, true);
    };
  }, [updateFileDropTarget]);

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
      const capturedSource = captureDocumentSource();
      const capturedFile = workspaceRef.current.files.find(file => file.id === capturedSource.documentId);
      if (!capturedFile) return;
      const snapshot = createWorkspaceSourceSnapshot(createExecutionDocumentSnapshot(
        capturedSource.documentId,
        capturedFile.name,
        capturedSource.sourceRevision,
        capturedSource.source,
      ), workspaceRef.current.files);
      if (!isRunnableBuildPlan(resolveBuildPlan(snapshot.files, snapshot.fileName))) return;
      runConsoleResetKey.current++;
      shouldFocusConsoleAfterRun.current = true;
      consoleLayout.setConsoleVisible(true);
      run(snapshot, executionConfiguration);
    }
  }, [captureDocumentSource, consoleLayout.setConsoleVisible, executionConfiguration, isRunning, run, stop]);

  const openMemoryViewer = useCallback(() => {
    const capturedSource = captureDocumentSource();
    const capturedFile = workspaceRef.current.files.find(file => file.id === capturedSource.documentId);
    if (!capturedFile) return;
    const snapshot = createWorkspaceSourceSnapshot(createExecutionDocumentSnapshot(
      capturedSource.documentId,
      capturedFile.name,
      capturedSource.sourceRevision,
      capturedSource.source,
    ), workspaceRef.current.files);
    if (!isRunnableBuildPlan(resolveBuildPlan(snapshot.files, snapshot.fileName))) return;
    setMemoryViewerDocument(snapshot);
  }, [captureDocumentSource]);

  const closeMemoryViewer = useCallback(() => {
    setMemoryViewerDocument(null);
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
        document: memoryViewerDocument,
        canOpen: isRunnableBuildPlan(buildResolution),
        configuration: executionConfiguration,
        onOpen: openMemoryViewer,
        onClose: closeMemoryViewer,
      }}
      run={{ isRunning, showStop, canRun: isRunnableBuildPlan(buildResolution), onRun }}
      editor={{
        ref,
        text,
        fileName: activeFile.name,
        persistenceLocked,
        files: workspace.files,
        activeFileId: activeFile.id,
        requestedFileId: workspace.activeFileId,
        isComposing,
        onSelectFile,
        onCreateFile,
        onRenameFile,
        onDeleteFile,
        initialText: activeFile.source,
        cursor,
        limitMessage,
        diagnostics: editorDiagnostics,
        sourceSnapshot: diagnosticSourceSnapshot,
        onDiagnosticNavigate: navigateDiagnosticLocation,
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
        diagnosticFiles: workspace.files,
        diagnosticSnapshot: state.status === 'finished' ? state.sourceSnapshot : undefined,
        onDiagnosticNavigate: navigateDiagnosticLocation,
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
        onLoadDebugExample: loadDebugExample,
        debugExampleDisabled: persistenceLocked,
      }}
      fileDrop={{
        target: fileDropTarget,
        notice: fileDropNotice,
        onDismissNotice: dismissFileDropNotice,
        onDragEnterCapture: onFileDragEnterCapture,
        onDragOverCapture: onFileDragOverCapture,
        onDragLeaveCapture: onFileDragLeaveCapture,
        onDropCapture: onFileDropCapture,
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
