import { scanC } from '../syntax.ts';
import type { Location } from './internal.ts';
import { preprocessError } from './preprocessor-errors.ts';
import { decodeIdentifier, translateLiteralUCNs } from './preprocessor-source.ts';
import type { Macro, PPToken } from './preprocessor-types.ts';

export const quoteC = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function cloneAt(token: PPToken, at: Location, options: { hideSet?: ReadonlySet<string>; leadingSpace?: boolean; text?: string; kind?: PPToken['kind']; spelling?: string } = {}): PPToken {
  return {
    ...token, at, physicalLine: token.physicalLine, physicalColumn: token.physicalColumn,
    expansionSite: token.expansionSite ?? at,
    hideSet: options.hideSet ?? token.hideSet, leadingSpace: options.leadingSpace ?? token.leadingSpace,
    text: options.text ?? token.text, spelling: options.spelling ?? token.spelling, kind: options.kind ?? token.kind,
  };
}

export function mergedHideSet(...sets: (ReadonlySet<string> | undefined)[]): ReadonlySet<string> | undefined {
  const merged = new Set<string>();
  for (const set of sets) if (set) for (const name of set) merged.add(name);
  return merged.size ? merged : undefined;
}

export function tokenText(tokens: readonly PPToken[]): string {
  let result = '';
  for (const token of tokens) {
    if (result && token.leadingSpace) result += ' ';
    result += token.text;
  }
  return result;
}

export function decodeCQuotedString(token: PPToken): string {
  if (token.kind !== 'string' || !token.text.startsWith('"') || !token.text.endsWith('"')) preprocessError('Expected a quoted C string.', token.at);
  const body = token.text.slice(1, -1);
  let result = '';
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character !== '\\') { result += character; continue; }
    const escaped = body[++index];
    if (escaped === undefined) preprocessError('Incomplete escape in preprocessor string.', token.at);
    const simple: Record<string, string> = { '"': '"', "'": "'", '?': '?', '\\': '\\', a: '\x07', b: '\x08', f: '\x0c', n: '\n', r: '\r', t: '\t', v: '\x0b' };
    if (Object.hasOwn(simple, escaped)) result += simple[escaped];
    else if (/[0-7]/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) digits += body[++index];
      result += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
    } else if (escaped === 'x') {
      let digits = '';
      while (/[0-9a-fA-F]/.test(body[index + 1] ?? '')) digits += body[++index];
      if (!digits) preprocessError('Hexadecimal escape has no digits in a preprocessor string.', token.at);
      result += String.fromCharCode(Number.parseInt(digits, 16) & 0xff);
    } else preprocessError(`Invalid escape in preprocessor string: \\${escaped}.`, token.at);
  }
  return result;
}

export function predefinedMacros(at: Location, dateText: string, timeText: string): Map<string, Macro> {
  const macros = new Map<string, Macro>();
  const fixed: Record<string, string> = {
    __STDC__: '1', __STDC_VERSION__: '201112L', __STDC_HOSTED__: '1',
    __STDC_NO_COMPLEX__: '1', __STDC_NO_ATOMICS__: '1', __STDC_NO_THREADS__: '1',
    __DATE__: quoteC(dateText), __TIME__: quoteC(timeText),
  };
  for (const [name, value] of Object.entries(fixed)) {
    const token: PPToken = { kind: name === '__DATE__' || name === '__TIME__' ? 'string' : 'number', text: value, spelling: value, at, physicalLine: at.line, physicalColumn: at.column, logicalStart: 0, logicalEnd: value.length, leadingSpace: false };
    macros.set(name, { name, variadic: false, replacement: [token], at });
  }
  for (const name of ['__FILE__', '__LINE__']) macros.set(name, { name, variadic: false, replacement: [], at });
  return macros;
}

export function syntheticToken(kind: PPToken['kind'], text: string, at: Location, leadingSpace = false, hideSet?: ReadonlySet<string>): PPToken {
  return { kind, text, spelling: text, at, physicalLine: at.line, physicalColumn: at.column, logicalStart: 0, logicalEnd: text.length, leadingSpace, ...(hideSet ? { hideSet } : {}) };
}

export function sameMacro(left: Macro, right: Macro): boolean {
  if (left.variadic !== right.variadic || left.parameters?.length !== right.parameters?.length || left.parameters?.some((name, index) => name !== right.parameters?.[index])) return false;
  return left.replacement.length === right.replacement.length && left.replacement.every((token, index) => token.kind === right.replacement[index].kind && token.text === right.replacement[index].text);
}

export function parseMacroArguments(tokens: readonly PPToken[], openIndex: number, at: Location, parameters: readonly string[] | undefined): { arguments: PPToken[][]; separators: PPToken[]; end: number } {
  const args: PPToken[][] = [[]];
  const separators: PPToken[] = [];
  let nesting = 0;
  let hasTokens = false;
  for (let index = openIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text === '(') { nesting++; args.at(-1)!.push(token); hasTokens = true; }
    else if (token.text === ')') {
      if (nesting === 0) {
        const actual = !hasTokens && args.length === 1 && args[0].length === 0 && parameters?.length === 0 ? [] : args;
        return { arguments: actual, separators, end: index };
      }
      nesting--; args.at(-1)!.push(token); hasTokens = true;
    } else if (token.text === ',' && nesting === 0) { separators.push(token); args.push([]); hasTokens = true; }
    else { args.at(-1)!.push(token); hasTokens = true; }
  }
  preprocessError('Macro invocation is missing its closing parenthesis.', at);
}

export function stringifyArgument(tokens: readonly PPToken[], at: Location, leadingSpace: boolean, hideSet?: ReadonlySet<string>): PPToken {
  let contents = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (index && token.leadingSpace) contents += ' ';
    contents += token.spelling;
  }
  const escaped = contents.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const text = `"${escaped}"`;
  return syntheticToken('string', text, at, leadingSpace, hideSet);
}

export function pastedToken(left: PPToken, right: PPToken, at: Location, hideSet: ReadonlySet<string> | undefined): PPToken {
  const text = left.text + right.text;
  const scanned = [...scanC(text)].filter((token) => token.kind !== 'whitespace');
  if (scanned.length !== 1 || scanned[0].start !== 0 || scanned[0].end !== text.length || scanned[0].closed === false || ['invalid', 'line-comment', 'block-comment', 'preprocessor'].includes(scanned[0].kind)) {
    preprocessError(`Token paste «${left.text} ## ${right.text}» does not form a C token.`, at, 'INVALID_TOKEN_PASTE');
  }
  const syntax = scanned[0];
  let kind: PPToken['kind'] = syntax.kind;
  let normalized = text;
  if (syntax.kind === 'identifier') normalized = decodeIdentifier(text, at);
  else if (syntax.kind === 'string' || syntax.kind === 'character') normalized = translateLiteralUCNs(text, at);
  return { ...left, kind, text: normalized, spelling: text, at, logicalStart: left.logicalStart, logicalEnd: right.logicalEnd, hideSet, leadingSpace: left.leadingSpace };
}

export function stringifyPragmaText(text: string): string[] {
  return text.trim().split(/[\t \v\f\r\n]+/).filter(Boolean);
}

export function rejectVaArgsOutsideVariadicReplacement(tokens: readonly PPToken[]): void {
  const occurrence = tokens.find((token) => token.kind === 'identifier' && token.text === '__VA_ARGS__');
  if (occurrence) {
    preprocessError('__VA_ARGS__ may only appear in the replacement list of a variadic function-like macro.', occurrence.at);
  }
}
