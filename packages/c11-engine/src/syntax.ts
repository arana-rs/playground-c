/** C11 words shared by the parser and source presentation. */
export const C_KEYWORDS: readonly string[] = Object.freeze(('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local').split(' '));

export const C_TYPE_KEYWORDS: readonly string[] = Object.freeze(['char', 'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double', 'void', '_Bool', '_Complex', '_Imaginary', 'enum', 'struct', 'union']);

export type SyntaxKind = 'whitespace' | 'identifier' | 'number' | 'string' | 'character' | 'line-comment' | 'block-comment' | 'preprocessor' | 'symbol' | 'invalid';

export interface SyntaxToken {
  kind: SyntaxKind;
  /** UTF-16 offsets into the original source, with an exclusive end. */
  start: number;
  end: number;
  line: number;
  column: number;
  closed?: boolean;
}

const identifierStart = /^[\p{ID_Start}_]$/u;
const identifierPart = /^[\p{ID_Continue}_]$/u;
const identifierUnitLength = (source: string, index: number, start: boolean): number => {
  if (source[index] === '\\' && (source[index + 1] === 'u' || source[index + 1] === 'U')) {
    const digits = source[index + 1] === 'u' ? 4 : 8;
    const spelling = source.slice(index + 2, index + 2 + digits);
    if (spelling.length === digits && /^[0-9a-fA-F]+$/.test(spelling)) {
      const codePoint = Number.parseInt(spelling, 16);
      if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        const character = String.fromCodePoint(codePoint);
        if ((start ? identifierStart : identifierPart).test(character)) return digits + 2;
      }
    }
  }
  const codePoint = source.codePointAt(index);
  if (codePoint === undefined) return 0;
  const character = String.fromCodePoint(codePoint);
  return (start ? identifierStart : identifierPart).test(character) ? character.length : 0;
};
const isDigit = (character: string) => character >= '0' && character <= '9';
const isWhitespace = (character: string) => ' \t\n\r\v\f'.includes(character);
const isNewline = (character: string) => character === '\n' || character === '\r';
const twoSymbols = new Set(['+=', '-=', '*=', '/=', '%=', '++', '--', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '->', '&=', '|=', '^=', '##']);
const threeSymbols = new Set(['<<=', '>>=', '...']);

/**
 * Lossless, tolerant C scanning for both editing and the engine's strict lexer.
 * Incomplete tokens remain useful while typing; consumers decide what they accept.
 */
export function* scanC(source: string): Generator<SyntaxToken> {
  let index = 0;
  let line = 1;
  let column = 1;
  let logicalLine = 1;
  let directiveAllowed = true;
  let expectHeader = false;
  const advance = () => {
    const continued = source[index - 1] === '\\';
    const character = source[index++];
    if (character === '\r') { if (source[index] === '\n') index++; line++; column = 1; }
    else if (character === '\n') { line++; column = 1; }
    else column++;
    if (isNewline(character) && !continued) { logicalLine++; directiveAllowed = true; }
  };
  while (index < source.length) {
    const start = index;
    const startLine = line;
    const startColumn = column;
    const startLogicalLine = logicalLine;
    let kind: SyntaxKind;
    let closed: boolean | undefined;
    const character = source[index];
    if (isWhitespace(character)) {
      kind = 'whitespace';
      do { advance(); } while (index < source.length && isWhitespace(source[index]));
    } else if (character === '\\' && isNewline(source[index + 1])) {
      kind = 'whitespace';
      advance(); advance();
    } else if (source.slice(index, index + 2) === '//') {
      kind = 'line-comment';
      advance(); advance();
      while (index < source.length && !isNewline(source[index])) {
        if (source[index] === '\\' && isNewline(source[index + 1])) {
          advance(); advance();
        } else advance();
      }
      closed = index < source.length;
    } else if (source.slice(index, index + 2) === '/*') {
      kind = 'block-comment';
      advance(); advance();
      while (index < source.length && source.slice(index, index + 2) !== '*/') advance();
      closed = index < source.length;
      if (closed) { advance(); advance(); }
    } else {
      const prefixLength = source.startsWith('u8', index) ? 2 : 'LuU'.includes(character) ? 1 : 0;
      const quote = source[index + prefixLength];
      if (expectHeader && character === '<') {
        kind = 'string';
        advance();
        while (index < source.length && source[index] !== '>' && !isNewline(source[index])) advance();
        closed = source[index] === '>';
        if (closed) advance();
      } else if (quote === '"' || quote === "'") {
        kind = quote === '"' ? 'string' : 'character';
        for (let offset = 0; offset <= prefixLength; offset++) advance();
        closed = false;
        while (index < source.length && !isNewline(source[index])) {
          if (source[index] === quote) { advance(); closed = true; break; }
          if (source[index] === '\\') {
            advance();
            if (index >= source.length) break;
          }
          advance();
        }
      } else if (identifierUnitLength(source, index, true)) {
        kind = 'identifier';
        for (let count = identifierUnitLength(source, index, true); count > 0; count--) advance();
        while (index < source.length && identifierUnitLength(source, index, false)) {
          for (let count = identifierUnitLength(source, index, false); count > 0; count--) advance();
        }
      } else if (isDigit(character) || (character === '.' && isDigit(source[index + 1] ?? ''))) {
        kind = 'number';
        // Preprocessing numbers keep suffixes, bases and exponent signs intact.
        do {
          advance();
        } while (index < source.length && (identifierUnitLength(source, index, false) > 0 || source[index] === '.' || ((source[index] === '+' || source[index] === '-') && /[eEpP]/.test(source[index - 1]))));
      } else if (character === '#' && directiveAllowed && source[index + 1] !== '#') {
        kind = 'preprocessor';
        advance();
        while (index < source.length && ' \t\v\f'.includes(source[index])) advance();
        if (identifierUnitLength(source, index, true)) {
          for (let count = identifierUnitLength(source, index, true); count > 0; count--) advance();
          while (index < source.length && identifierUnitLength(source, index, false)) {
            for (let count = identifierUnitLength(source, index, false); count > 0; count--) advance();
          }
        }
      } else {
        const triple = source.slice(index, index + 3);
        const pair = source.slice(index, index + 2);
        const length = threeSymbols.has(triple) ? 3 : twoSymbols.has(pair) ? 2 : 1;
        kind = length > 1 || '#{}()[];,+-*/%=!~&|^<>?:.'.includes(character) ? 'symbol' : 'invalid';
        for (let offset = 0; offset < length; offset++) advance();
      }
    }
    if (kind === 'preprocessor') expectHeader = /^#[ \t\v\f]*include$/.test(source.slice(start, index));
    else if (kind === 'whitespace' || kind === 'block-comment') {
      if (logicalLine !== startLogicalLine) expectHeader = false;
    } else expectHeader = false;
    if (kind !== 'whitespace' && kind !== 'line-comment' && kind !== 'block-comment') directiveAllowed = false;
    yield { kind, start, end: index, line: startLine, column: startColumn, ...(closed === undefined ? {} : { closed }) };
  }
}
