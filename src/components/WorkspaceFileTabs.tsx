import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { Button } from './arc/button/button.tsx';
import { getWorkspaceFileNameError } from '../editor/sourcePersistence.ts';
import type { WorkspaceFile, WorkspaceFileNameError } from '../editor/sourcePersistence.ts';
import { useI18n } from '../i18n.tsx';

interface WorkspaceFileTabsProps {
  files: readonly WorkspaceFile[];
  activeFileId: string;
  requestedFileId: string;
  isComposing: boolean;
  persistenceLocked: boolean;
  onSelectFile: (fileId: string) => void;
  onCreateFile: () => WorkspaceFile | null;
  onRenameFile: (fileId: string, name: string) => void;
  onDeleteFile: (fileId: string) => void;
}

interface FileMenuState {
  fileId: string;
  left: number;
  top: number;
}

const FILE_MENU_VIEWPORT_GUTTER = 8;

function getMenuPosition(x: number, y: number): Pick<FileMenuState, 'left' | 'top'> {
  return {
    left: Math.max(x, FILE_MENU_VIEWPORT_GUTTER),
    top: Math.max(y, FILE_MENU_VIEWPORT_GUTTER),
  };
}

export function WorkspaceFileTabs({
  files,
  activeFileId,
  requestedFileId,
  isComposing,
  persistenceLocked,
  onSelectFile,
  onCreateFile,
  onRenameFile,
  onDeleteFile,
}: WorkspaceFileTabsProps) {
  const { t } = useI18n();
  const activeFile = files.find(file => file.id === activeFileId) ?? files[0]!;
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<WorkspaceFileNameError | null>(null);
  const [pendingRenameFileId, setPendingRenameFileId] = useState<string | null>(null);
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);
  const [menuFocusIndex, setMenuFocusIndex] = useState(0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const editingFile = renamingFileId === null ? undefined : files.find(file => file.id === renamingFileId);
  const menuFile = fileMenu === null ? undefined : files.find(file => file.id === fileMenu.fileId);
  const menuDeleteDisabled = !menuFile
    || persistenceLocked
    || files.length <= 1
    || (isComposing && menuFile.id === activeFileId);

  useLayoutEffect(() => {
    if (!editingFile) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editingFile?.id]);

  useLayoutEffect(() => {
    if (pendingRenameFileId === null) return;
    if (requestedFileId !== pendingRenameFileId) {
      setPendingRenameFileId(null);
      return;
    }
    if (activeFileId !== pendingRenameFileId) return;
    const file = files.find(candidate => candidate.id === pendingRenameFileId);
    if (!file) {
      setPendingRenameFileId(null);
      return;
    }
    setPendingRenameFileId(null);
    startRename(file);
  }, [activeFileId, files, pendingRenameFileId, requestedFileId]);

  useLayoutEffect(() => {
    if (fileMenu !== null) menuItemRefs.current[menuFocusIndex]?.focus();
  }, [fileMenu, menuFocusIndex]);

  useLayoutEffect(() => {
    if (fileMenu === null) return;
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = Math.max(FILE_MENU_VIEWPORT_GUTTER, window.innerWidth - width - FILE_MENU_VIEWPORT_GUTTER);
    const maxTop = Math.max(FILE_MENU_VIEWPORT_GUTTER, window.innerHeight - height - FILE_MENU_VIEWPORT_GUTTER);
    const left = Math.min(fileMenu.left, maxLeft);
    const top = Math.min(fileMenu.top, maxTop);
    if (left === fileMenu.left && top === fileMenu.top) return;
    setFileMenu(current => current?.fileId === fileMenu.fileId
      ? { ...current, left, top }
      : current);
  }, [fileMenu]);

  useEffect(() => {
    if (renamingFileId !== null && !files.some(file => file.id === renamingFileId)) {
      setRenamingFileId(null);
      setRenameError(null);
    }
  }, [files, renamingFileId]);

  useEffect(() => {
    if (!persistenceLocked) return;
    setFileMenu(null);
    setRenamingFileId(null);
    setRenameError(null);
    setPendingRenameFileId(null);
  }, [persistenceLocked]);

  useEffect(() => {
    if (fileMenu !== null && !files.some(file => file.id === fileMenu.fileId)) setFileMenu(null);
  }, [fileMenu, files]);

  useEffect(() => {
    if (fileMenu === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setFileMenu(null);
    };
    const closeOnViewportChange = () => setFileMenu(null);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [fileMenu]);

  function restoreFileFocus(fileId: string | null) {
    if (fileId === null) return;
    window.requestAnimationFrame(() => tabRefs.current.get(fileId)?.focus({ preventScroll: true }));
  }

  function closeFileMenu(restoreFocus = true) {
    const fileId = fileMenu?.fileId ?? null;
    setFileMenu(null);
    if (restoreFocus) restoreFileFocus(fileId);
  }

  function cancelRename(restoreFocus = true) {
    const fileId = renamingFileId;
    setRenamingFileId(null);
    setRenameError(null);
    if (restoreFocus) restoreFileFocus(fileId);
  }

  function startRename(file: WorkspaceFile) {
    if (persistenceLocked) return;
    setFileMenu(null);
    setRenameValue(file.name);
    setRenameError(null);
    setRenamingFileId(file.id);
  }

  function saveRename(fileId: string) {
    if (persistenceLocked) return;
    const file = files.find(candidate => candidate.id === fileId);
    if (!file) {
      cancelRename(false);
      return;
    }
    const normalizedName = renameValue.trim();
    const validationError = getWorkspaceFileNameError(normalizedName, files, fileId);
    if (validationError !== null) {
      setRenameError(validationError);
      renameInputRef.current?.focus();
      return;
    }
    onRenameFile(fileId, normalizedName);
    cancelRename();
  }

  function openFileMenu(fileId: string, x: number, y: number) {
    if (persistenceLocked) return;
    setMenuFocusIndex(0);
    setFileMenu({ fileId, ...getMenuPosition(x, y) });
  }

  function openFileMenuFromKeyboard(fileId: string, trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    openFileMenu(fileId, rect.left, rect.bottom);
  }

  function handleTabContextMenu(event: MouseEvent<HTMLButtonElement>, fileId: string) {
    if (persistenceLocked) return;
    event.preventDefault();
    openFileMenu(fileId, event.clientX, event.clientY);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, fileId: string, index: number) {
    if (persistenceLocked) return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openFileMenuFromKeyboard(fileId, event.currentTarget);
      return;
    }

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % files.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + files.length) % files.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = files.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextFile = files[nextIndex]!;
    tabRefs.current.get(nextFile.id)?.focus();
    onSelectFile(nextFile.id);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFileMenu();
      return;
    }
    if (event.key === 'Tab') {
      window.setTimeout(() => setFileMenu(null), 0);
      return;
    }

    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (menuFocusIndex + 1) % 2;
    else if (event.key === 'ArrowUp') nextIndex = (menuFocusIndex + 1) % 2;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setMenuFocusIndex(nextIndex);
  }

  function deleteFile(fileId: string) {
    if (persistenceLocked) return;
    if (files.length <= 1 || (isComposing && fileId === activeFileId)) return;
    const deletedIndex = files.findIndex(file => file.id === fileId);
    if (deletedIndex < 0) return;
    const remainingFiles = files.filter(file => file.id !== fileId);
    const nextRequestedFileId = requestedFileId === fileId
      ? remainingFiles[Math.min(deletedIndex, remainingFiles.length - 1)]?.id ?? null
      : requestedFileId;
    setFileMenu(null);
    onDeleteFile(fileId);
    restoreFileFocus(nextRequestedFileId);
  }

  const menuStyle: CSSProperties | undefined = fileMenu === null
    ? undefined
    : { left: fileMenu.left, top: fileMenu.top };

  return (
    <div className="workspace-file-tabs">
      <div className="workspace-file-tabs__list" role="group" aria-label={t('file.tabs')}>
        {files.map((file, index) => {
          const isActive = file.id === activeFile.id;
          const isPending = file.id === requestedFileId && !isActive;
          if (renamingFileId === file.id) {
            return (
              <div className={`workspace-file-tab${isActive ? ' workspace-file-tab--active' : ''} workspace-file-tab--renaming`} key={file.id}>
                <input
                  ref={renameInputRef}
                  className="workspace-file-tab__rename-input"
                  type="text"
                  disabled={persistenceLocked}
                  aria-label={t('file.renameInput', { file: file.name })}
                  aria-invalid={renameError !== null || undefined}
                  aria-describedby={renameError ? 'workspace-file-rename-error' : undefined}
                  value={renameValue}
                  onChange={event => {
                    setRenameValue(event.currentTarget.value);
                    setRenameError(null);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveRename(file.id);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                />
                <button
                  className="workspace-file-tab__rename-action"
                  type="button"
                  disabled={persistenceLocked}
                  aria-label={t('file.saveRename')}
                  title={t('file.saveRename')}
                  onClick={() => saveRename(file.id)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="m3 8 3.2 3.2L13 4.5" />
                  </svg>
                </button>
                <button
                  className="workspace-file-tab__rename-action"
                  type="button"
                  aria-label={t('file.cancelRename')}
                  title={t('file.cancelRename')}
                  onClick={() => cancelRename()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="m4 4 8 8M12 4l-8 8" />
                  </svg>
                </button>
                {renameError !== null && (
                  <span className="workspace-file-tab__rename-error" id="workspace-file-rename-error" role="alert">
                    {t(renameError === 'empty'
                      ? 'file.renameRequired'
                      : renameError === 'duplicate' ? 'file.renameDuplicate' : 'file.renameInvalid')}
                  </span>
                )}
              </div>
            );
          }
          const menuIsOpen = fileMenu?.fileId === file.id;
          return (
            <button
              ref={node => {
                if (node) tabRefs.current.set(file.id, node);
                else tabRefs.current.delete(file.id);
              }}
              className={`workspace-file-tab${isActive ? ' workspace-file-tab--active' : ''}${isPending ? ' workspace-file-tab--pending' : ''}`}
              key={file.id}
              type="button"
              disabled={persistenceLocked}
              aria-pressed={isActive}
              aria-controls={menuIsOpen ? 'editor-pane workspace-file-context-menu' : 'editor-pane'}
              aria-haspopup="menu"
              aria-expanded={menuIsOpen}
              aria-keyshortcuts="Shift+F10"
              aria-description={persistenceLocked
                ? t('workspace.unsupportedFormat')
                : isPending ? t('file.selectionPending', { file: file.name }) : t('file.contextMenuHelp')}
              title={persistenceLocked ? file.name : `${file.name} · ${t('file.contextMenuHelp')}`}
              onClick={() => {
                if (persistenceLocked) return;
                setFileMenu(null);
                onSelectFile(file.id);
              }}
              onContextMenu={event => handleTabContextMenu(event, file.id)}
              onKeyDown={event => handleTabKeyDown(event, file.id, index)}
            >
              <span className="workspace-file-tab__name">{file.name}</span>
              {isPending && <span className="workspace-file-tab__pending-mark" aria-hidden="true" />}
            </button>
          );
        })}
        <button
          className="workspace-file-tab__create"
          type="button"
          disabled={persistenceLocked}
          aria-label={t('file.create')}
          title={t('file.create')}
          onClick={() => {
            if (persistenceLocked) return;
            const file = onCreateFile();
            if (!file) return;
            setPendingRenameFileId(file.id);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      {menuFile && fileMenu !== null && (
        <div
          ref={menuRef}
          id="workspace-file-context-menu"
          className="workspace-file-context-menu"
          role="menu"
          aria-label={t('file.actions', { file: menuFile.name })}
          style={menuStyle}
          onKeyDown={handleMenuKeyDown}
        >
          <Button
            ref={node => { menuItemRefs.current[0] = node; }}
            className="workspace-file-context-menu__item"
            variant="ghost"
            size="sm"
            type="button"
            role="menuitem"
            tabIndex={menuFocusIndex === 0 ? 0 : -1}
            disabled={persistenceLocked}
            onFocus={() => setMenuFocusIndex(0)}
            onClick={() => startRename(menuFile)}
          >
            <svg className="workspace-file-context-menu__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m3 11.8.6-3L10.8 1.6a1.2 1.2 0 0 1 1.7 0l1 1a1.2 1.2 0 0 1 0 1.7l-7.2 7.2-3.3.3ZM9.8 2.6l3.6 3.6M2.5 14.5h11" />
            </svg>
            {t('file.renameAction')}
          </Button>
          <Button
            ref={node => { menuItemRefs.current[1] = node; }}
            className="workspace-file-context-menu__item workspace-file-context-menu__item--danger"
            variant="danger"
            size="sm"
            type="button"
            role="menuitem"
            tabIndex={menuFocusIndex === 1 ? 0 : -1}
            disabled={persistenceLocked}
            aria-disabled={menuDeleteDisabled}
            title={files.length <= 1 ? t('file.deleteLast') : isComposing && menuFile.id === activeFileId ? t('file.deleteComposing') : undefined}
            onFocus={() => setMenuFocusIndex(1)}
            onClick={() => deleteFile(menuFile.id)}
          >
            <svg className="workspace-file-context-menu__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M2.5 4.5h11M6 4.5V2.8h4v1.7m2.4 0-.6 9H4.2l-.6-9M6.5 7v4M9.5 7v4" />
            </svg>
            {t('file.deleteAction')}
          </Button>
        </div>
      )}
    </div>
  );
}
