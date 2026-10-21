export interface ExecutionDocumentSnapshot {
  readonly documentId: string;
  readonly fileName: string;
  readonly sourceRevision: number;
  readonly source: string;
}

export interface CurrentDocumentVersion {
  readonly documentId: string;
  readonly fileName: string;
  readonly sourceRevision: number;
  readonly source: string;
}

export interface WorkspaceSourceFileSnapshot {
  readonly id: string;
  readonly name: string;
  readonly source: string;
}

/** A transferable, immutable C project captured from the editor workspace. */
export interface WorkspaceSourceSnapshot extends ExecutionDocumentSnapshot {
  /** The active source file is the only translation unit; siblings are available to quoted includes. */
  readonly entry: string;
  readonly files: readonly WorkspaceSourceFileSnapshot[];
  readonly translationUnits: readonly string[];
}

export type WorkspaceSourceFileInput = Pick<WorkspaceSourceFileSnapshot, 'id' | 'name' | 'source'>;

/** Copy the editor's effective document identity and source into an immutable run snapshot. */
export function createExecutionDocumentSnapshot(
  documentId: string,
  fileName: string,
  sourceRevision: number,
  source: string,
): ExecutionDocumentSnapshot {
  return Object.freeze({ documentId, fileName, sourceRevision, source });
}

/**
 * Copy one active editor document and every workspace source into an immutable
 * project snapshot. Only the active file is selected for translation.
 */
export function createWorkspaceSourceSnapshot(
  document: ExecutionDocumentSnapshot,
  workspaceFiles: readonly WorkspaceSourceFileInput[] = [
    { id: document.documentId, name: document.fileName, source: document.source },
  ],
): WorkspaceSourceSnapshot {
  if (!workspaceFiles.some(file => file.id === document.documentId)) {
    throw new Error('The active source file is missing from the workspace snapshot.');
  }

  const names = new Set<string>();
  const files = workspaceFiles.map(file => {
    const name = file.id === document.documentId ? document.fileName : file.name;
    if (names.has(name)) throw new Error('Workspace source file names must be unique.');
    names.add(name);
    return Object.freeze({
      id: file.id,
      name,
      source: file.id === document.documentId ? document.source : file.source,
    });
  });
  const frozenFiles = Object.freeze(files);
  const translationUnits = Object.freeze([document.fileName]);
  return Object.freeze({
    documentId: document.documentId,
    fileName: document.fileName,
    sourceRevision: document.sourceRevision,
    source: document.source,
    entry: document.fileName,
    files: frozenFiles,
    translationUnits,
  });
}

/** Copy a snapshot again when a Worker request must own a stable source capture. */
export function cloneWorkspaceSourceSnapshot(snapshot: WorkspaceSourceSnapshot): WorkspaceSourceSnapshot {
  return createWorkspaceSourceSnapshot(snapshot, snapshot.files);
}

/** Compare every compiler-visible workspace source and its entry selection. */
export function sameWorkspaceSourceSnapshot(
  left: WorkspaceSourceSnapshot,
  right: WorkspaceSourceSnapshot,
): boolean {
  return left.documentId === right.documentId
    && left.entry === right.entry
    && left.translationUnits.length === right.translationUnits.length
    && left.translationUnits.every((unit, index) => unit === right.translationUnits[index])
    && left.files.length === right.files.length
    && left.files.every((file, index) => {
      const other = right.files[index];
      return other !== undefined && file.id === other.id && file.name === other.name && file.source === other.source;
    });
}

/** A result can decorate the editor only while it still shows the captured document version. */
export function matchesCurrentDocument(
  snapshot: ExecutionDocumentSnapshot,
  current: CurrentDocumentVersion,
): boolean {
  return snapshot.documentId === current.documentId
    && snapshot.fileName === current.fileName
    && snapshot.sourceRevision === current.sourceRevision
    && snapshot.source === current.source;
}
