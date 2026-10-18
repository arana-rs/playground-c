import type { EngineMetrics, PrepareLimits } from './types.ts';
import { enforceLimit, failure } from './internal.ts';
import type { Location, SourceSpan, Token } from './internal.ts';
import { scanC, type SyntaxKind } from '../syntax.ts';

/** Convert one preprocessing token into the parser's smaller token vocabulary. */
export function lexPreprocessingToken(
  kind: SyntaxKind,
  text: string,
  at: Location,
  endAt?: Location,
  sourceSpan?: SourceSpan,
): Token {
  const sourcePosition = {
    ...(endAt ? { endLine: endAt.line, endColumn: endAt.column } : {}),
    ...(sourceSpan ? { sourceSpan } : {}),
  };
  const literalPrefix = /^(u8|[LuU])(['"])/.exec(text);
  if (literalPrefix && !(literalPrefix[1] === 'u8' && literalPrefix[2] === '"')) {
    failure('UNSUPPORTED_FEATURE', 'This profile does not implement wide literals.', at);
  }
  if (kind === 'identifier' || kind === 'symbol') return { kind, text, ...at, ...sourcePosition };
  if (kind === 'number') {
    const hexadecimal = /^0[xX]/.test(text);
    return { kind: text.includes('.') || (hexadecimal ? /[pP]/ : /[eE]/).test(text) ? 'floating' : 'integer', text, ...at, ...sourcePosition };
  }
  if (kind === 'string') {
    if ((!text.startsWith('"') && !text.startsWith('u8"')) || !text.endsWith('"')) failure('UNTERMINATED_STRING', 'Unterminated string literal.', at);
    return { kind: 'string', text, ...at, ...sourcePosition };
  }
  if (kind === 'character') {
    if (!text.startsWith("'") || !text.endsWith("'")) failure('UNTERMINATED_CHARACTER', 'Unterminated character literal.', at);
    return { kind: 'character', text, ...at, ...sourcePosition };
  }
  if (kind === 'invalid') failure('INVALID_TOKEN', `Unrecognized character: ${text}.`, at);
  failure('UNSUPPORTED_FEATURE', `Unsupported preprocessor token: ${text}.`, at);
}

export function lex(source: string, file: string, limits: PrepareLimits, metrics: EngineMetrics): Token[] {
  // C translation phases run before comment removal. Reject pending features
  // globally so a line splice hidden inside // cannot change program meaning.
  let checkLine = 1;
  let checkColumn = 1;
  for (let offset = 0; offset < source.length; offset++) {
    const at = { file, line: checkLine, column: checkColumn };
    if (source.slice(offset, offset + 2) === '??' && "=/'()!<>-".includes(source[offset + 2] ?? '\0')) failure('UNSUPPORTED_FEATURE', 'P3 does not yet implement C11 trigraphs.', at);
    if (source[offset] === '\\' && (source[offset + 1] === '\n' || source[offset + 1] === '\r')) failure('UNSUPPORTED_FEATURE', 'P3 does not yet implement C line splicing.', at);
    if (source[offset] === '\r') { if (source[offset + 1] === '\n') offset++; checkLine++; checkColumn = 1; }
    else if (source[offset] === '\n') { checkLine++; checkColumn = 1; }
    else checkColumn++;
  }
  const tokens: Token[] = [];
  const emit = (kind: Token['kind'], text: string, at: Location) => {
    metrics.tokenCount++;
    enforceLimit('maxTokens', metrics.tokenCount, limits.maxTokens, at);
    tokens.push({ kind, text, ...at });
  };
  for (const token of scanC(source)) {
    const start: Location = { file, line: token.line, column: token.column };
    if (token.kind === 'whitespace' || token.kind === 'line-comment') continue;
    if (token.kind === 'block-comment') {
      if (!token.closed) failure('UNTERMINATED_COMMENT', 'Unterminated block comment */.', start);
      continue;
    }
    const text = source.slice(token.start, token.end);
    if (text.startsWith('#')) failure('UNSUPPORTED_FEATURE', 'P3 does not yet implement the general preprocessor.', start);
    if (token.kind === 'invalid' && text === '\\') failure('UNSUPPORTED_FEATURE', 'P2 does not yet implement identifier escapes or line splicing.', start);
    if (token.kind === 'string' && !token.closed) failure('UNTERMINATED_STRING', 'Unterminated string literal.', start);
    if (token.kind === 'character' && !token.closed) failure('UNTERMINATED_CHARACTER', 'Unterminated character literal.', start);
    const parsed = lexPreprocessingToken(token.kind, text, start);
    emit(parsed.kind, parsed.text, start);
  }
  tokens.push({ kind: 'eof', text: '', file, line: checkLine, column: checkColumn });
  return tokens;
}
