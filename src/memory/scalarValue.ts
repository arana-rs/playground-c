import { truncateMiddle } from './truncateMiddle.ts';

export const MEMORY_VIEWER_SCALAR_VALUE_MAX_CHARACTERS = 10;
const SCALAR_VALUE_PREFIX_CHARACTERS = 5;
const SCALAR_VALUE_SUFFIX_CHARACTERS = 2;

export function truncateMemoryViewerScalarValue(value: string): string {
  return truncateMiddle(
    value,
    MEMORY_VIEWER_SCALAR_VALUE_MAX_CHARACTERS,
    SCALAR_VALUE_PREFIX_CHARACTERS,
    SCALAR_VALUE_SUFFIX_CHARACTERS,
  );
}
