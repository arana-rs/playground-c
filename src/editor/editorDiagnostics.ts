import { scanC } from '@playground/c11-engine/syntax';
import type { Diagnostic } from '@playground/c11-engine/core';

export interface EditorDiagnosticAnchor {
  readonly line: number;
  readonly column: number;
  /** UTF-16 length of this source fragment, split at physical line boundaries. */
  readonly length: number;
}

export interface EditorDiagnosticRelatedLocation {
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  /** Stable workspace identity only when this note maps to a physical source location. */
  readonly sourceId?: string;
  /** Physical source fragments are available only when this location maps safely to the editor. */
  readonly anchors: readonly EditorDiagnosticAnchor[];
}

/** A parser diagnostic whose coordinates can be projected onto the current editor source. */
export interface EditorDiagnostic extends Diagnostic {
  /** Stable for the same diagnostic location and duplicate occurrence. */
  readonly id: string;
  /** First physical fragment; EOF diagnostics have a marker but no text underline. */
  readonly anchor: EditorDiagnosticAnchor | null;
  /** All physical fragments of the primary diagnostic range. */
  readonly anchors: readonly EditorDiagnosticAnchor[];
  /** Related engine locations, with source fragments only for safe current-file mappings. */
  readonly relatedLocations: readonly EditorDiagnosticRelatedLocation[];
}

export interface EditorDiagnosticGroup {
  /** Physical editor line used by the gutter marker. */
  readonly line: number;
  readonly diagnostics: readonly EditorDiagnostic[];
}

export interface EditorSourceLocationTarget {
  readonly sourceId?: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export type EditorSourceLocationResolution =
  | {
    readonly status: 'available';
    readonly documentId: string;
    readonly fileName: string;
    readonly source: string;
    readonly offset: number;
    readonly stale: boolean;
  }
  | { readonly status: 'unavailable'; readonly reason: 'unknown-source' | 'missing-source' | 'invalid-location' };

interface DiagnosticSourceLocation {
  readonly message?: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

type DiagnosticWithRanges = Diagnostic & {
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly related?: readonly DiagnosticSourceLocation[];
};

interface SourceLine {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

const TRIVIA_KINDS = new Set(['whitespace', 'line-comment', 'block-comment']);

function preprocessingView(source: string): string {
  // The scanner does not run translation phases 1 and 2. Apply only the
  // transformations that can turn a source line into a #line directive.
  return source
    .replace(/\?\?=/g, '#')
    .replace(/\?\?\//g, '\\')
    .replace(/\\(?:\r\n|\r|\n)/g, '')
    .replace(/%:/g, '#');
}

function couldRemapLines(source: string): boolean {
  const view = preprocessingView(source);
  const tokens = [...scanC(view)];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const text = view.slice(token.start, token.end);
    if (token.kind === 'preprocessor') {
      const head = text.replace(/[\t\v\f ]/g, '');
      if (head === '#line') return true;
      if (head === '#') {
        // Comments are replaced by whitespace before directive handling, so
        // also recognize `# /* comment */ line` through the shared scanner.
        for (let next = index + 1; next < tokens.length; next++) {
          const candidate = tokens[next];
          const candidateText = view.slice(candidate.start, candidate.end);
          if (TRIVIA_KINDS.has(candidate.kind)) {
            if (candidateText.includes('\n') || candidateText.includes('\r')) break;
            continue;
          }
          if (candidate.kind === 'identifier' && candidateText === 'line') return true;
          break;
        }
      }
      continue;
    }
  }
  return false;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '\r' && source[index] !== '\n') continue;
    const next = source[index] === '\r' && source[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push({ number: line++, start, end: index, next });
    start = next;
    index = next - 1;
  }
  lines.push({ number: line, start, end: source.length, next: source.length });
  return lines;
}

function isSafeCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function lineOffset(lines: readonly SourceLine[], line: number, column: number): number | null {
  if (!isSafeCoordinate(line) || !isSafeCoordinate(column)) return null;
  const sourceLine = lines[line - 1];
  if (!sourceLine) return null;
  const offset = sourceLine.start + column - 1;
  return offset <= sourceLine.end ? offset : null;
}

/** Convert a 1-based diagnostic position with the editor's UTF-16 and CRLF rules. */
export function getEditorSourceLocationOffset(
  source: string,
  line: number,
  column = 1,
  clamp = false,
): number | null {
  if (!isSafeCoordinate(line) || !isSafeCoordinate(column)) return null;
  const lines = sourceLines(source);
  if (!clamp) return lineOffset(lines, line, column);

  const boundedLine = Math.min(line, lines.length);
  const sourceLine = lines[boundedLine - 1];
  if (!sourceLine) return null;
  const boundedColumn = Math.min(column, sourceLine.end - sourceLine.start + 1);
  return lineOffset(lines, boundedLine, boundedColumn);
}

/** A logical C location cannot be mapped to editor lines when the source uses #line. */
export function isEditorSourceLocationNavigable(
  source: string,
  fileName: string,
  line: number,
  column = 1,
): boolean {
  if (fileName !== 'Makefile' && couldRemapLines(source)) return false;
  return getEditorSourceLocationOffset(source, line, column) !== null;
}

/** Resolve captured diagnostic identity against the current workspace by ID, never by name. */
export function resolveEditorSourceLocation(
  location: EditorSourceLocationTarget,
  currentFiles: readonly { readonly id: string; readonly name: string; readonly source: string }[],
  capturedFiles: readonly { readonly id: string; readonly name: string; readonly source: string }[],
): EditorSourceLocationResolution {
  if (!location.sourceId) return { status: 'unavailable', reason: 'unknown-source' };
  const capturedFile = capturedFiles.find(file => file.id === location.sourceId);
  if (!capturedFile) return { status: 'unavailable', reason: 'unknown-source' };
  const currentFile = currentFiles.find(file => file.id === location.sourceId);
  if (!currentFile) return { status: 'unavailable', reason: 'missing-source' };
  const offset = getEditorSourceLocationOffset(currentFile.source, location.line, location.column, true);
  if (offset === null) return { status: 'unavailable', reason: 'invalid-location' };
  return {
    status: 'available',
    documentId: currentFile.id,
    fileName: currentFile.name,
    source: currentFile.source,
    offset,
    stale: currentFile.source !== capturedFile.source,
  };
}

function isLowSurrogate(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return false;
  const codeUnit = source.charCodeAt(offset);
  const previous = source.charCodeAt(offset - 1);
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff;
}

function projectLegacyAnchor(
  source: string,
  lines: readonly SourceLine[],
  line: number,
  column: number,
): EditorDiagnosticAnchor | null {
  const start = lineOffset(lines, line, column);
  const sourceLine = lines[line - 1];
  if (start === null || !sourceLine || start === sourceLine.end) return null;
  const adjustedStart = isLowSurrogate(source, start) ? start - 1 : start;
  const codePoint = source.codePointAt(adjustedStart);
  if (codePoint === undefined) return null;
  return {
    line,
    column: adjustedStart - sourceLine.start + 1,
    length: codePoint > 0xffff ? 2 : 1,
  };
}

function validRange(
  lines: readonly SourceLine[],
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): { start: number; end: number } | null {
  const start = lineOffset(lines, startLine, startColumn);
  const end = lineOffset(lines, endLine, endColumn);
  if (start === null || end === null || end <= start) return null;
  if (endLine < startLine || (endLine === startLine && endColumn <= startColumn)) return null;
  // A source token cannot start at the end of a line or within its line break.
  const startSourceLine = lines[startLine - 1];
  if (!startSourceLine || start >= startSourceLine.end) return null;
  return { start, end };
}

function projectRangeFragments(
  source: string,
  lines: readonly SourceLine[],
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): EditorDiagnosticAnchor[] | null {
  const range = validRange(lines, startLine, startColumn, endLine, endColumn);
  if (!range) return null;

  const startOffset = isLowSurrogate(source, range.start) ? range.start - 1 : range.start;
  const endOffset = isLowSurrogate(source, range.end) ? range.end + 1 : range.end;
  const firstLine = lines[startLine - 1];
  if (!firstLine) return null;
  const projected: EditorDiagnosticAnchor[] = [];

  for (let number = startLine; number <= endLine; number++) {
    const sourceLine = lines[number - 1];
    if (!sourceLine) return null;
    const fragmentStart = Math.max(startOffset, sourceLine.start);
    const fragmentEnd = Math.min(endOffset, sourceLine.end);
    if (fragmentEnd <= fragmentStart) continue;
    projected.push({
      line: number,
      column: fragmentStart - sourceLine.start + 1,
      length: fragmentEnd - fragmentStart,
    });
  }

  if (projected.length === 0) return null;
  return projected;
}

function projectLocationAnchors(
  source: string,
  lines: readonly SourceLine[],
  location: DiagnosticSourceLocation,
  fileName: string,
): EditorDiagnosticAnchor[] {
  if (location.file !== fileName) return [];
  const hasEndLine = location.endLine !== undefined;
  const hasEndColumn = location.endColumn !== undefined;
  if (hasEndLine && hasEndColumn) {
    const exact = projectRangeFragments(
      source,
      lines,
      location.line,
      location.column,
      location.endLine!,
      location.endColumn!,
    );
    if (exact) return exact;
  }
  const fallback = projectLegacyAnchor(source, lines, location.line, location.column);
  return fallback ? [fallback] : [];
}

/**
 * Keeps original engine locations and adds physical source fragments only when
 * the logical and physical locations can be matched safely.
 */
export function projectEditorDiagnostics(
  source: string,
  diagnostics: readonly Diagnostic[],
  fileName = 'main.c',
  workspaceFiles?: readonly { readonly id: string; readonly name: string; readonly source: string }[],
): EditorDiagnostic[] {
  if (couldRemapLines(source)) return [];

  const lines = sourceLines(source);
  const occurrences = new Map<string, number>();
  const projected: EditorDiagnostic[] = [];
  for (const rawDiagnostic of diagnostics) {
    const diagnostic = rawDiagnostic as DiagnosticWithRanges;
    if (diagnostic.file !== fileName || !isSafeCoordinate(diagnostic.line) || !isSafeCoordinate(diagnostic.column)) continue;
    const primaryLine = lines[diagnostic.line - 1];
    const primaryOffset = getEditorSourceLocationOffset(source, diagnostic.line, diagnostic.column);
    if (!primaryLine || primaryOffset === null
      || (primaryOffset === primaryLine.end && diagnostic.line !== lines.length)) continue;
    const primaryLocation: DiagnosticSourceLocation = {
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      endLine: diagnostic.endLine,
      endColumn: diagnostic.endColumn,
    };
    const anchors = projectLocationAnchors(source, lines, primaryLocation, fileName);
    const anchor = anchors[0] ?? null;
    const relatedLocations = (diagnostic.related ?? []).map(location => {
      const sourceFile = workspaceFiles?.find(file => file.name === location.file);
      const sourceId = sourceFile
        && isEditorSourceLocationNavigable(sourceFile.source, sourceFile.name, location.line, location.column)
        ? sourceFile.id
        : undefined;
      return {
        ...location,
        message: location.message ?? '',
        anchors: projectLocationAnchors(source, lines, location, fileName),
        ...(sourceId ? { sourceId } : {}),
      };
    });

    const signature = JSON.stringify([
      diagnostic.file,
      diagnostic.line,
      diagnostic.column,
      diagnostic.code,
      diagnostic.endLine,
      diagnostic.endColumn,
    ]);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    projected.push({
      ...diagnostic,
      id: `${signature}:${occurrence}`,
      anchor,
      anchors,
      relatedLocations,
    });
  }
  return projected;
}

/** Groups every diagnostic on each primary source line, without counting related locations as errors. */
export function groupEditorDiagnosticsByLine(diagnostics: readonly EditorDiagnostic[]): EditorDiagnosticGroup[] {
  const groups = new Map<number, EditorDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const affectedLines = diagnostic.anchors.length > 0
      ? new Set(diagnostic.anchors.map(anchor => anchor.line))
      : new Set([diagnostic.line]);
    for (const line of affectedLines) {
      const existing = groups.get(line);
      if (existing) existing.push(diagnostic);
      else groups.set(line, [diagnostic]);
    }
  }
  return [...groups]
    .sort(([left], [right]) => left - right)
    .map(([line, lineDiagnostics]) => ({ line, diagnostics: lineDiagnostics }));
}

/** Projects source locations and groups them for editor gutter markers. */
export function projectEditorDiagnosticGroups(
  source: string,
  diagnostics: readonly Diagnostic[],
  fileName = 'main.c',
  workspaceFiles?: readonly { readonly id: string; readonly name: string; readonly source: string }[],
): EditorDiagnosticGroup[] {
  return groupEditorDiagnosticsByLine(projectEditorDiagnostics(source, diagnostics, fileName, workspaceFiles));
}
