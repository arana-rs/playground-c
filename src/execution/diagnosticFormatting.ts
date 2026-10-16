export interface DiagnosticLocation {
  file: string;
  line: number;
  column: number;
}

export function formatDiagnosticLocation(item: DiagnosticLocation): string {
  return `${item.file}:${item.line}:${item.column}`;
}
