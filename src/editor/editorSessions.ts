import { createEditorHistory } from './history.ts';
import type { EditorViewport } from './editorEditing.ts';
import type { EditorSnapshot } from './types.ts';
import { notifyEditorSourceChange } from './sourcePersistence.ts';
import { evaluateEditorTextReplacement } from './operations.ts';

export type EditorSessionTextReplacement =
  | { status: 'applied'; snapshot: EditorSnapshot }
  | { status: 'line-limit'; snapshot: EditorSnapshot }
  | null;

export interface EditorSession {
  readonly documentId: string;
  snapshot: EditorSnapshot;
  readonly history: ReturnType<typeof createEditorHistory>;
  viewport: EditorViewport;
  publishedText: string;
  sourceRevision: number;
}

export interface PendingEditorLocationNavigation {
  readonly requestId: number;
  readonly documentId: string;
  readonly line: number;
  readonly column: number;
}

export interface EditorLocationNavigationRequest {
  readonly requestId: number;
  readonly session: EditorSession | null;
}

export function updateEditorSessionSnapshot(session: EditorSession, snapshot: EditorSnapshot): void {
  if (snapshot.text !== session.snapshot.text) session.sourceRevision += 1;
  session.snapshot = snapshot;
}

/** Replace a session's whole source in one history step and place its caret at the start. */
export function replaceEditorSessionText(
  session: EditorSession,
  replacement: string,
): EditorSessionTextReplacement {
  const before = session.snapshot;
  const evaluation = evaluateEditorTextReplacement(before, 0, before.text.length, replacement);
  if (!evaluation || evaluation.status === 'line-limit') return evaluation;

  const snapshot: EditorSnapshot = {
    ...evaluation.snapshot,
    selection: { start: 0, end: 0, direction: 'none' },
  };
  session.history.breakGroup();
  session.history.record(before, snapshot);
  session.history.breakGroup();
  updateEditorSessionSnapshot(session, snapshot);
  return { status: 'applied', snapshot };
}

export function publishEditorSessionSource(
  session: EditorSession,
  source: string,
  onSourceChange?: (documentId: string, source: string) => void,
): string {
  session.publishedText = notifyEditorSourceChange(
    source,
    session.publishedText,
    nextSource => onSourceChange?.(session.documentId, nextSource),
  );
  return session.publishedText;
}

export class EditorSessionStore {
  private readonly sessions = new Map<string, EditorSession>();
  private readonly removeWhenInactive = new Set<string>();
  private activeDocumentId: string;
  private pendingActivation: { documentId: string; source: string } | null = null;
  private pendingLocationNavigation: PendingEditorLocationNavigation | null = null;
  private nextLocationNavigationId = 0;
  private compositionPending = false;

  constructor(documentId: string, source: string, initialSnapshot: EditorSnapshot) {
    this.activeDocumentId = documentId;
    this.sessions.set(documentId, this.createSession(documentId, source, initialSnapshot));
  }

  get active(): EditorSession {
    return this.sessions.get(this.activeDocumentId)!;
  }

  get activeId(): string {
    return this.activeDocumentId;
  }

  get isCompositionPending(): boolean {
    return this.compositionPending;
  }

  get(documentId: string): EditorSession | undefined {
    return this.sessions.get(documentId);
  }

  removeDocument(documentId: string): boolean {
    if (this.pendingActivation?.documentId === documentId) this.pendingActivation = null;
    this.cancelLocationNavigation(documentId);
    if (documentId === this.activeDocumentId) {
      this.removeWhenInactive.add(documentId);
      return true;
    }
    this.removeWhenInactive.delete(documentId);
    return this.sessions.delete(documentId);
  }

  beginComposition(): void {
    this.compositionPending = true;
  }

  handleBlur(onCompositionPending: () => void, onIdle: () => void): void {
    if (this.compositionPending) onCompositionPending();
    else onIdle();
  }

  requestActivation(documentId: string, source: string): EditorSession | null {
    if (documentId === this.activeDocumentId) {
      this.pendingActivation = null;
      return this.active;
    }
    if (this.compositionPending) {
      this.pendingActivation = { documentId, source };
      return null;
    }
    this.pendingActivation = null;
    return this.activate(documentId, source);
  }

  requestLocationNavigation(
    documentId: string,
    source: string,
    line: number,
    column: number,
  ): EditorLocationNavigationRequest {
    const requestId = ++this.nextLocationNavigationId;
    this.pendingLocationNavigation = { requestId, documentId, line, column };
    return { requestId, session: this.requestActivation(documentId, source) };
  }

  consumeLocationNavigation(documentId: string): PendingEditorLocationNavigation | null {
    const pending = this.pendingLocationNavigation;
    if (!pending) return null;
    this.pendingLocationNavigation = null;
    return pending.documentId === documentId ? pending : null;
  }

  cancelLocationNavigationUnless(documentId: string): void {
    if (this.pendingLocationNavigation?.documentId === documentId) return;
    this.cancelLocationNavigation();
  }

  cancelLocationNavigation(documentId?: string): void {
    if (documentId !== undefined && this.pendingLocationNavigation?.documentId !== documentId) return;
    this.pendingLocationNavigation = null;
    this.nextLocationNavigationId += 1;
  }

  finishComposition(): EditorSession | null {
    this.compositionPending = false;
    const pending = this.pendingActivation;
    this.pendingActivation = null;
    if (pending === null || pending.documentId === this.activeDocumentId) return null;
    return this.activate(pending.documentId, pending.source);
  }

  private activate(documentId: string, source: string): EditorSession {
    const previousDocumentId = this.activeDocumentId;
    this.activeDocumentId = documentId;
    const existing = this.sessions.get(documentId);
    if (existing) {
      this.discardPreviousIfRequested(previousDocumentId, documentId);
      return existing;
    }

    const normalizedSource = source.replace(/\r\n?/g, '\n');
    const initialSnapshot: EditorSnapshot = {
      text: normalizedSource,
      selection: { start: 0, end: 0, direction: 'none' },
      pairs: [],
    };
    const session = this.createSession(documentId, normalizedSource, initialSnapshot);
    this.sessions.set(documentId, session);
    this.discardPreviousIfRequested(previousDocumentId, documentId);
    return session;
  }

  private discardPreviousIfRequested(previousDocumentId: string, nextDocumentId: string): void {
    if (previousDocumentId !== nextDocumentId && this.removeWhenInactive.delete(previousDocumentId)) {
      this.sessions.delete(previousDocumentId);
    }
  }

  private createSession(documentId: string, source: string, initialSnapshot: EditorSnapshot): EditorSession {
    return {
      documentId,
      snapshot: initialSnapshot,
      history: createEditorHistory(initialSnapshot),
      viewport: { scrollTop: 0, scrollLeft: 0 },
      publishedText: source,
      sourceRevision: 0,
    };
  }
}
