import type { DebugSourceLocation } from '@playground/c11-engine/core';
import type { Translate } from '../i18n.tsx';

/** Show the captured source file for known locations and retain the logical file for fallback locations. */
export function formatMemoryViewerLocationLabel(
  location: DebugSourceLocation | null,
  sourceFileName: string,
  t: Translate,
): string {
  if (!location) return '';
  if (location.file === sourceFileName) return `${sourceFileName}:${location.line}:${location.column}`;
  return t('memoryViewer.location', {
    file: location.file,
    line: location.line,
    column: location.column,
  });
}
