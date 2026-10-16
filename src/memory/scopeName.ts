import { truncateMiddle } from './truncateMiddle.ts';

export const MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS = 20;
const SCOPE_NAME_PREFIX_CHARACTERS = 15;
const SCOPE_NAME_SUFFIX_CHARACTERS = 2;

/** Keep scope labels readable in the compact vertical stack while preserving both ends. */
export function truncateMemoryViewerScopeName(scopeName: string): string {
  return truncateMiddle(
    scopeName,
    MEMORY_VIEWER_SCOPE_NAME_MAX_CHARACTERS,
    SCOPE_NAME_PREFIX_CHARACTERS,
    SCOPE_NAME_SUFFIX_CHARACTERS,
  );
}
