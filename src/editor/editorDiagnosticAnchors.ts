import type { EditorDiagnosticGroup } from './editorDiagnostics.ts';

export interface EditorDiagnosticAnchorRange {
  start: number;
  length: number;
  kind: 'primary' | 'related';
  diagnosticLine: number;
}

export function getEditorDiagnosticAnchorRanges(
  text: string,
  diagnosticGroups: readonly EditorDiagnosticGroup[],
): EditorDiagnosticAnchorRange[] {
  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text[offset] === '\r') {
      if (text[offset + 1] === '\n') offset++;
      lineStarts.push(offset + 1);
    } else if (text[offset] === '\n') {
      lineStarts.push(offset + 1);
    }
  }

  const ranges: EditorDiagnosticAnchorRange[] = [];
  for (const group of diagnosticGroups) {
    for (const diagnostic of group.diagnostics) {
      for (const anchor of diagnostic.anchors) {
        if (anchor.line !== group.line || anchor.line < 1 || anchor.column < 1) continue;
        const lineStart = lineStarts[anchor.line - 1];
        const lineEnd = lineStarts[anchor.line] ?? text.length;
        if (lineStart === undefined) continue;
        const start = lineStart + anchor.column - 1;
        if (start >= lineStart && start + anchor.length <= lineEnd) {
          ranges.push({ start, length: anchor.length, kind: 'primary', diagnosticLine: group.line });
        }
      }
      if (group.line === diagnostic.line) {
        for (const related of diagnostic.relatedLocations) {
          for (const anchor of related.anchors) {
            if (anchor.line < 1 || anchor.column < 1) continue;
            const lineStart = lineStarts[anchor.line - 1];
            const lineEnd = lineStarts[anchor.line] ?? text.length;
            if (lineStart === undefined) continue;
            const start = lineStart + anchor.column - 1;
            if (start >= lineStart && start + anchor.length <= lineEnd) {
              ranges.push({ start, length: anchor.length, kind: 'related', diagnosticLine: diagnostic.line });
            }
          }
        }
      }
    }
  }
  return ranges;
}
