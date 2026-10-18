/** The editor accepts at most this many logical lines in one file. */
export const MAX_EDITOR_LINES = 999;

export type EditorLimitMessage =
  | { readonly kind: 'line-limit' }
  | { readonly kind: 'file-too-long'; readonly lineCount: number };

export const EDITOR_LINE_LIMIT_MESSAGE: EditorLimitMessage = { kind: 'line-limit' };

/** Match textarea line endings before counting, highlighting, or applying edits. */
export function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

/** Empty text has one line; a final LF starts an additional empty line. */
export function getEditorLineCount(text: string): number {
  return normalizeEditorText(text).split('\n').length;
}

export function isEditorTextWithinLineLimit(text: string): boolean {
  return getEditorLineCount(text) <= MAX_EDITOR_LINES;
}

/** Use at document-load boundaries to report an oversized source without truncating it. */
export function getEditorLineLimitDiagnostic(text: string): EditorLimitMessage | null {
  const lineCount = getEditorLineCount(text);
  return lineCount <= MAX_EDITOR_LINES
    ? null
    : { kind: 'file-too-long', lineCount };
}
