import {
  addWorkspaceFile,
  getWorkspaceFileNameError,
} from './sourcePersistence.ts';
import type { Workspace, WorkspaceFile } from './sourcePersistence.ts';
import { getEditorLineCount, isEditorTextWithinLineLimit, normalizeEditorText } from './limits.ts';

export const MAX_IMPORTED_SOURCE_BYTES = 1_048_576;

export type FileDropTarget = 'page' | 'tabs' | 'editor';

export type FileDropImportRejection =
  | 'multiple-files'
  | 'unsupported-extension'
  | 'invalid-name'
  | 'duplicate-name'
  | 'file-too-large'
  | 'too-many-lines'
  | 'invalid-utf8'
  | 'contains-nul'
  | 'read-failed'
  | 'file-id-conflict';

export interface DroppedSourceFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PreparedDroppedSource {
  readonly name: string;
  readonly source: string;
}

export type FileDropImportResult<T> =
  | { readonly status: 'accepted'; readonly value: T }
  | {
    readonly status: 'rejected';
    readonly reason: FileDropImportRejection;
    readonly fileName: string;
    readonly lineCount?: number;
  };

export function isFileTransfer(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types).some(type => type.toLowerCase() === 'files')) return true;
  return Array.from(dataTransfer.items).some(item => item.kind === 'file');
}

export function preflightDroppedFiles(
  files: readonly DroppedSourceFile[],
  workspace: Workspace,
): FileDropImportResult<DroppedSourceFile> {
  if (files.length !== 1) {
    return {
      status: 'rejected',
      reason: 'multiple-files',
      fileName: files[0]?.name ?? '',
    };
  }

  const file = files[0]!;
  if (!file.name.endsWith('.c')) {
    return { status: 'rejected', reason: 'unsupported-extension', fileName: file.name };
  }
  if (file.name !== file.name.trim() || getWorkspaceFileNameError(file.name) !== null) {
    return { status: 'rejected', reason: 'invalid-name', fileName: file.name };
  }
  const nameError = getWorkspaceFileNameError(file.name, workspace.files);
  if (nameError === 'duplicate') {
    return { status: 'rejected', reason: 'duplicate-name', fileName: file.name };
  }
  if (nameError !== null) {
    return { status: 'rejected', reason: 'invalid-name', fileName: file.name };
  }
  if (file.size > MAX_IMPORTED_SOURCE_BYTES) {
    return { status: 'rejected', reason: 'file-too-large', fileName: file.name };
  }

  return { status: 'accepted', value: file };
}

export async function readDroppedSource(
  file: DroppedSourceFile,
): Promise<FileDropImportResult<PreparedDroppedSource>> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { status: 'rejected', reason: 'read-failed', fileName: file.name };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { status: 'rejected', reason: 'invalid-utf8', fileName: file.name };
  }

  if (decoded.includes('\0')) {
    return { status: 'rejected', reason: 'contains-nul', fileName: file.name };
  }

  const source = normalizeEditorText(decoded);
  if (!isEditorTextWithinLineLimit(source)) {
    return {
      status: 'rejected',
      reason: 'too-many-lines',
      fileName: file.name,
      lineCount: getEditorLineCount(source),
    };
  }

  return { status: 'accepted', value: { name: file.name, source } };
}

export async function prepareDroppedSource(
  files: readonly DroppedSourceFile[],
  workspace: Workspace,
): Promise<FileDropImportResult<PreparedDroppedSource>> {
  const preflight = preflightDroppedFiles(files, workspace);
  if (preflight.status === 'rejected') return preflight;
  return readDroppedSource(preflight.value);
}

export function addPreparedDroppedSource(
  workspace: Workspace,
  prepared: PreparedDroppedSource,
  id: string,
): FileDropImportResult<{ readonly workspace: Workspace; readonly file: WorkspaceFile }> {
  const nameError = getWorkspaceFileNameError(prepared.name, workspace.files);
  if (nameError === 'duplicate') {
    return { status: 'rejected', reason: 'duplicate-name', fileName: prepared.name };
  }
  if (nameError !== null || prepared.name !== prepared.name.trim() || !prepared.name.endsWith('.c')) {
    return { status: 'rejected', reason: 'invalid-name', fileName: prepared.name };
  }
  if (workspace.files.some(file => file.id === id)) {
    return { status: 'rejected', reason: 'file-id-conflict', fileName: prepared.name };
  }

  const file: WorkspaceFile = { id, name: prepared.name, source: prepared.source };
  const nextWorkspace = addWorkspaceFile(workspace, file);
  if (nextWorkspace === workspace) {
    return { status: 'rejected', reason: 'invalid-name', fileName: prepared.name };
  }
  return { status: 'accepted', value: { workspace: nextWorkspace, file } };
}
