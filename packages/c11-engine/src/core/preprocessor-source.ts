import type { SyntaxToken } from '../syntax.ts';
import { encodeUtf8Bytes } from './numeric.ts';
import type { Location } from './internal.ts';
import { preprocessError } from './preprocessor-errors.ts';
import type { MappedSource } from './preprocessor-types.ts';

const TRIGRAPHS: Readonly<Record<string, string>> = Object.freeze({
  '??=': '#', '??/': '\\', "??'": '^', '??(': '[', '??)': ']', '??!': '|', '??<': '{', '??>': '}', '??-': '~',
});
// C11 permits only these UCN values below U+00A0.
const BASIC_UCN_EXCEPTIONS = new Set([0x24, 0x40, 0x60]);

export function normalizeVirtualPath(path: string, at: Location): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) preprocessError(`Invalid virtual name: «${path}».`, at, 'INVALID_PROJECT');
  const components: string[] = [];
  for (const component of path.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!components.length) preprocessError(`Virtual path «${path}» escapes the project root.`, at, 'INVALID_PROJECT');
      components.pop();
    } else components.push(component);
  }
  if (!components.length) preprocessError(`Invalid virtual name: «${path}».`, at, 'INVALID_PROJECT');
  return components.join('/');
}

export function joinVirtualPath(directory: string, relative: string, at: Location): string {
  return normalizeVirtualPath(directory ? `${directory}/${relative}` : relative, at);
}

export function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function sourcePositions(source: string): { lineAt(offset: number): number; columnAt(offset: number): number } {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index++;
      starts.push(index + 1);
    } else if (source[index] === '\n') starts.push(index + 1);
  }
  const lineStart = (offset: number): number => {
    let low = 0, high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  };
  return {
    lineAt: (offset) => lineStart(offset) + 1,
    columnAt: (offset) => offset - starts[lineStart(offset)] + 1,
  };
}

/** Translation phases 1 and 2, retaining the physical start offset of every code unit. */
export function translatePhasesOneAndTwo(source: string): MappedSource {
  let phaseOne = '';
  const phaseOneOffsets: number[] = [];
  const phaseOneEnds: number[] = [];
  for (let index = 0; index < source.length;) {
    const trigraph = source.slice(index, index + 3);
    const replacement = TRIGRAPHS[trigraph];
    if (replacement !== undefined) {
      phaseOne += replacement;
      phaseOneOffsets.push(index);
      phaseOneEnds.push(index + 3);
      index += 3;
    } else {
      phaseOne += source[index];
      phaseOneOffsets.push(index);
      phaseOneEnds.push(index + 1);
      index++;
    }
  }
  let text = '';
  const physicalOffsets: number[] = [];
  const physicalEnds: number[] = [];
  for (let index = 0; index < phaseOne.length;) {
    if (phaseOne[index] === '\\' && phaseOne[index + 1] === '\n') { index += 2; continue; }
    if (phaseOne[index] === '\\' && phaseOne[index + 1] === '\r') {
      index += phaseOne[index + 2] === '\n' ? 3 : 2;
      continue;
    }
    text += phaseOne[index];
    physicalOffsets.push(phaseOneOffsets[index]);
    physicalEnds.push(phaseOneEnds[index]);
    index++;
  }
  return { text, physicalOffsets, physicalEnds, eofOffset: source.length };
}

export function physicalSpan(mapped: MappedSource, start: number, end: number): { start: number; end: number } {
  const physicalStart = mapped.physicalOffsets[start] ?? mapped.eofOffset;
  return {
    start: physicalStart,
    end: end > start ? mapped.physicalEnds[end - 1] ?? physicalStart : physicalStart,
  };
}

export function universalValue(spelling: string, at: Location): number | undefined {
  const match = /^\\u([0-9a-fA-F]{4})$/.exec(spelling) ?? /^\\U([0-9a-fA-F]{8})$/.exec(spelling);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 16);
  if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) || (value < 0xa0 && !BASIC_UCN_EXCEPTIONS.has(value))) {
    preprocessError(`Invalid universal character name: «${spelling}».`, at, 'INVALID_UNIVERSAL_CHARACTER_NAME');
  }
  return value;
}

export function decodeIdentifier(spelling: string, at: Location): string {
  return spelling.replace(/\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}/g, (match) => String.fromCodePoint(universalValue(match, at)!));
}

export function translateLiteralUCNs(text: string, at: Location): string {
  const prefix = /^(?:u8|[LuU])?/.exec(text)![0];
  const quote = text[prefix.length];
  if (quote !== '"' && quote !== "'") return text;
  const body = text.slice(prefix.length + 1, -1);
  let translated = '';
  for (let index = 0; index < body.length;) {
    // The second slash in an escaped backslash is not the start of a UCN.
    if (body[index] === '\\' && body[index + 1] === '\\') {
      translated += body.slice(index, index + 2);
      index += 2;
      continue;
    }
    const match = /^\\u[0-9a-fA-F]{4}|^\\U[0-9a-fA-F]{8}/.exec(body.slice(index));
    if (!match) { translated += body[index++]; continue; }
    const codePoint = universalValue(match[0], at)!;
    if (quote === "'" && codePoint > 0x7f) preprocessError('The 8-bit char profile cannot represent a non-ASCII UCN in a character constant.', at, 'UNSUPPORTED_FEATURE');
    // Fixed-width octal escapes keep the next source character from extending
    // the byte value, as can happen with a variable-width hexadecimal escape.
    translated += encodeUtf8Bytes(codePoint).map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    index += match[0].length;
  }
  return `${prefix}${quote}${translated}${quote}`;
}

export function physicalLocation(file: string, source: string, offsets: ReturnType<typeof sourcePositions>, physicalOffset: number): Location & { physicalLine: number; physicalColumn: number } {
  const safeOffset = Math.min(physicalOffset, source.length);
  return { file, line: offsets.lineAt(safeOffset), column: offsets.columnAt(safeOffset), physicalLine: offsets.lineAt(safeOffset), physicalColumn: offsets.columnAt(safeOffset) };
}

export function syntaxTokenAt(token: SyntaxToken, mapped: MappedSource, source: string, file: string, positions: ReturnType<typeof sourcePositions>): Location & { physicalLine: number; physicalColumn: number } {
  const physicalOffset = mapped.physicalOffsets[token.start] ?? mapped.eofOffset;
  return physicalLocation(file, source, positions, physicalOffset);
}
