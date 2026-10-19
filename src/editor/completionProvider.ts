import { CAPABILITIES } from '@playground/c11-engine/core';
import { C_KEYWORDS, C_TYPE_KEYWORDS, scanC, type SyntaxToken } from '@playground/c11-engine/syntax';

export type CompletionTrigger = 'automatic' | 'manual';

export interface CompletionRequest {
  readonly source: string;
  readonly cursorOffset: number;
  readonly trigger: CompletionTrigger;
}

export interface CompletionResult {
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly options: readonly string[];
}

const MAX_COMPLETION_OPTIONS = 6;
const AUTOMATIC_PREFIX_LENGTH = 2;
const TRIVIA_KINDS = new Set(['whitespace', 'line-comment', 'block-comment']);
const NON_CODE_KINDS = new Set(['string', 'character', 'line-comment', 'block-comment']);

const STANDARD_FUNCTION_NAMES = [
  ...CAPABILITIES.stdioFunctions,
  ...CAPABILITIES.stdlibFunctions,
  ...CAPABILITIES.stringFunctions,
  ...CAPABILITIES.timeFunctions,
  ...CAPABILITIES.ctypeFunctions,
  ...CAPABILITIES.inttypesFunctions,
  ...CAPABILITIES.mathFunctions,
];

const C_COMPLETION_NAMES = Object.freeze([...new Set([
  ...C_KEYWORDS,
  ...C_TYPE_KEYWORDS,
  ...STANDARD_FUNCTION_NAMES,
])].sort());

const HEADER_COMPLETION_NAMES = Object.freeze([...CAPABILITIES.virtualHeaders].sort());

interface HeaderContext {
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
}

function isTrivia(token: SyntaxToken): boolean {
  return TRIVIA_KINDS.has(token.kind);
}

function previousSignificantToken(tokens: readonly SyntaxToken[], beforeIndex: number): number {
  let index = beforeIndex - 1;
  while (index >= 0 && isTrivia(tokens[index])) index -= 1;
  return index;
}

function hasUnsplicedNewline(source: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (source[index] === '\\' && (source[index + 1] === '\n' || source[index + 1] === '\r')) {
      index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 2 : 1;
      continue;
    }
    if (source[index] === '\n' || source[index] === '\r') return true;
  }
  return false;
}

function isIncludeDirectiveBefore(
  source: string,
  tokens: readonly SyntaxToken[],
  headerStart: number,
  index: number,
): boolean {
  const includeIndex = previousSignificantToken(tokens, index);
  if (includeIndex < 0 || hasUnsplicedNewline(source, tokens[includeIndex].end, headerStart)) return false;
  const includeToken = tokens[includeIndex];
  const includeText = source.slice(includeToken.start, includeToken.end);
  if (includeToken.kind === 'preprocessor' && /^#[\t\v\f ]*include$/.test(includeText)) return true;
  if (includeToken.kind !== 'identifier' || source.slice(includeToken.start, includeToken.end) !== 'include') return false;

  const hashIndex = previousSignificantToken(tokens, includeIndex);
  if (hashIndex < 0 || hasUnsplicedNewline(source, tokens[hashIndex].end, headerStart)) return false;
  const hashToken = tokens[hashIndex];
  const hashText = source.slice(hashToken.start, hashToken.end);
  return hashToken.kind === 'preprocessor' && /^#[\t\v\f ]*$/.test(hashText);
}

function isIncludeHeaderToken(source: string, tokens: readonly SyntaxToken[], index: number): boolean {
  const header = tokens[index];
  const opener = source[header.start];
  return (opener === '<' || opener === '"') && isIncludeDirectiveBefore(source, tokens, header.start, index);
}

function findAngleHeaderEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && (source[index + 1] === '\n' || source[index + 1] === '\r')) {
      index += source[index + 1] === '\r' && source[index + 2] === '\n' ? 2 : 1;
      continue;
    }
    if (character === '>' || character === '\n' || character === '\r') return index;
  }
  return source.length;
}

function findHeaderContext(source: string, tokens: readonly SyntaxToken[], cursorOffset: number): HeaderContext | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'string' || !isIncludeHeaderToken(source, tokens, index)) continue;

    const start = token.start + 1;
    const end = token.closed ? token.end - 1 : token.end;
    if (cursorOffset < start || cursorOffset > end) continue;
    return { start, end, prefix: source.slice(start, cursorOffset) };
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'symbol' || source.slice(token.start, token.end) !== '<') continue;
    if (!isIncludeDirectiveBefore(source, tokens, token.start, index)) continue;

    const start = token.end;
    const end = findAngleHeaderEnd(source, start);
    if (cursorOffset < start || cursorOffset > end) continue;
    return { start, end, prefix: source.slice(start, cursorOffset) };
  }
  return null;
}

function suggestionsFor(catalog: readonly string[], prefix: string): readonly string[] {
  return catalog.filter((name) => name.startsWith(prefix)).slice(0, MAX_COMPLETION_OPTIONS);
}

function makeResult(start: number, end: number, options: readonly string[]): CompletionResult | null {
  return options.length === 0 ? null : { replaceStart: start, replaceEnd: end, options };
}

function isCursorInsideNonCodeToken(token: SyntaxToken, cursorOffset: number): boolean {
  if (!NON_CODE_KINDS.has(token.kind) || cursorOffset < token.start) return false;
  if (cursorOffset < token.end) return true;
  if (cursorOffset !== token.end) return false;
  return token.kind === 'line-comment' || token.closed === false;
}

/** Suggest published C names without parsing or depending on a valid translation unit. */
export function getCompletionSuggestions(request: CompletionRequest): CompletionResult | null {
  const { source, cursorOffset, trigger } = request;
  if (!Number.isInteger(cursorOffset) || cursorOffset < 0 || cursorOffset > source.length) return null;

  const tokens = [...scanC(source)];
  const header = findHeaderContext(source, tokens, cursorOffset);
  if (header) {
    if (trigger === 'automatic' && header.prefix.length < AUTOMATIC_PREFIX_LENGTH) return null;
    return makeResult(header.start, header.end, suggestionsFor(HEADER_COMPLETION_NAMES, header.prefix));
  }

  if (tokens.some((token) => isCursorInsideNonCodeToken(token, cursorOffset))) return null;

  const identifier = tokens.find((token) =>
    token.kind === 'identifier' && token.start <= cursorOffset && cursorOffset <= token.end,
  );
  if (identifier) {
    const prefix = source.slice(identifier.start, cursorOffset);
    if (trigger === 'automatic' && prefix.length < AUTOMATIC_PREFIX_LENGTH) return null;
    return makeResult(identifier.start, identifier.end, suggestionsFor(C_COMPLETION_NAMES, prefix));
  }

  if (trigger === 'automatic') return null;
  return makeResult(cursorOffset, cursorOffset, suggestionsFor(C_COMPLETION_NAMES, ''));
}
