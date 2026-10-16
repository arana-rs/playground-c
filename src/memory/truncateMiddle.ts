/** Truncate by Unicode code point while preserving the beginning and end. */
export function truncateMiddle(
  value: string,
  maxCharacters: number,
  prefixCharacters: number,
  suffixCharacters: number,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;

  const suffix = suffixCharacters === 0 ? [] : characters.slice(-suffixCharacters);
  return `${characters.slice(0, prefixCharacters).join('')}...${suffix.join('')}`;
}
