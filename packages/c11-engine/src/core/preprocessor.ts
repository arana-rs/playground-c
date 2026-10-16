import { scanC, type SyntaxKind, type SyntaxToken } from '../syntax.ts';
import { getStandardHeader } from './headers.ts';
import { EngineFailure, failure, enforceLimit } from './internal.ts';
import type { Location, Token } from './internal.ts';
import { lexPreprocessingToken } from './lexer.ts';
import type { EngineMetrics, PrepareLimits, SourceProject } from './types.ts';
import { parseLiteral } from './numeric.ts';

export interface PreprocessedUnit {
  readonly name: string;
  readonly tokens: Token[];
}

interface PPToken {
  kind: SyntaxKind | 'header';
  text: string;
  spelling: string;
  at: Location;
  /** Physical source span survives #line remapping and macro substitution. */
  physicalFile?: string;
  physicalOffset?: number;
  physicalEndOffset?: number;
  expansionSite?: Location;
  physicalLine: number;
  physicalColumn: number;
  logicalStart: number;
  logicalEnd: number;
  leadingSpace: boolean;
  hideSet?: ReadonlySet<string>;
  placemarker?: boolean;
}

interface PPLine { readonly number: number; readonly tokens: PPToken[] }
interface Macro { readonly name: string; readonly parameters?: readonly string[]; readonly variadic: boolean; readonly replacement: readonly PPToken[]; readonly at: Location }
interface PPContext {
  readonly macros: Map<string, Macro>;
  readonly files: ReadonlyMap<string, string>;
  readonly onceFiles: Set<string>;
  readonly limits: PrepareLimits;
  readonly metrics: EngineMetrics;
  readonly dateText: string;
  readonly timeText: string;
}
interface Conditional { readonly parentActive: boolean; active: boolean; branchTaken: boolean; sawElse: boolean; readonly at: Location }

const TRIGRAPHS: Readonly<Record<string, string>> = Object.freeze({
  '??=': '#', '??/': '\\', "??'": '^', '??(': '[', '??)': ']', '??!': '|', '??<': '{', '??>': '}', '??-': '~',
});
const MAX_INTERNAL_DEPTH = 2048;
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const quoteC = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function preprocessError(message: string, at: Location, code = 'PREPROCESSOR_ERROR'): never {
  return failure(code, message, at);
}

function normalizeVirtualPath(path: string, at: Location): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) preprocessError(`Nombre virtual no válido: «${path}».`, at, 'INVALID_PROJECT');
  const components: string[] = [];
  for (const component of path.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!components.length) preprocessError(`La ruta virtual «${path}» sale de la raíz del proyecto.`, at, 'INVALID_PROJECT');
      components.pop();
    } else components.push(component);
  }
  if (!components.length) preprocessError(`Nombre virtual no válido: «${path}».`, at, 'INVALID_PROJECT');
  return components.join('/');
}

function joinVirtualPath(directory: string, relative: string, at: Location): string {
  return normalizeVirtualPath(directory ? `${directory}/${relative}` : relative, at);
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function sourcePositions(source: string): { lineAt(offset: number): number; columnAt(offset: number): number } {
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

interface MappedSource {
  readonly text: string;
  readonly physicalOffsets: readonly number[];
  readonly physicalEnds: readonly number[];
  readonly eofOffset: number;
}

/** Translation phases 1 and 2, retaining the physical start offset of every code unit. */
function translatePhasesOneAndTwo(source: string): MappedSource {
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

function physicalSpan(mapped: MappedSource, start: number, end: number): { start: number; end: number } {
  const physicalStart = mapped.physicalOffsets[start] ?? mapped.eofOffset;
  return {
    start: physicalStart,
    end: end > start ? mapped.physicalEnds[end - 1] ?? physicalStart : physicalStart,
  };
}

function universalValue(spelling: string, at: Location): number | undefined {
  const match = /^\\u([0-9a-fA-F]{4})$/.exec(spelling) ?? /^\\U([0-9a-fA-F]{8})$/.exec(spelling);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 16);
  if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) preprocessError(`Nombre universal de carácter no válido: «${spelling}».`, at, 'INVALID_UNIVERSAL_CHARACTER_NAME');
  return value;
}

function decodeIdentifier(spelling: string, at: Location): string {
  return spelling.replace(/\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}/g, (match) => String.fromCodePoint(universalValue(match, at)!));
}

function utf8Bytes(codePoint: number): number[] {
  if (codePoint <= 0x7f) return [codePoint];
  if (codePoint <= 0x7ff) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  if (codePoint <= 0xffff) return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
  return [0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
}

function translateLiteralUCNs(text: string, at: Location): string {
  const prefix = /^(?:u8|[LuU])?/.exec(text)![0];
  const quote = text[prefix.length];
  if (quote !== '"' && quote !== "'") return text;
  const body = text.slice(prefix.length + 1, -1);
  let translated = '';
  for (let index = 0; index < body.length;) {
    const match = /^\\u[0-9a-fA-F]{4}|^\\U[0-9a-fA-F]{8}/.exec(body.slice(index));
    if (!match) { translated += body[index++]; continue; }
    const codePoint = universalValue(match[0], at)!;
    if (quote === "'" && codePoint > 0x7f) preprocessError('El perfil de char de 8 bits no representa un UCN no ASCII en una constante de carácter.', at, 'UNSUPPORTED_FEATURE');
    translated += utf8Bytes(codePoint).map((byte) => `\\x${byte.toString(16).toUpperCase()}`).join('');
    index += match[0].length;
  }
  return `${prefix}${quote}${translated}${quote}`;
}

function physicalLocation(file: string, source: string, offsets: ReturnType<typeof sourcePositions>, physicalOffset: number): Location & { physicalLine: number; physicalColumn: number } {
  const safeOffset = Math.min(physicalOffset, source.length);
  return { file, line: offsets.lineAt(safeOffset), column: offsets.columnAt(safeOffset), physicalLine: offsets.lineAt(safeOffset), physicalColumn: offsets.columnAt(safeOffset) };
}

function syntaxTokenAt(token: SyntaxToken, mapped: MappedSource, source: string, file: string, positions: ReturnType<typeof sourcePositions>): Location & { physicalLine: number; physicalColumn: number } {
  const physicalOffset = mapped.physicalOffsets[token.start] ?? mapped.eofOffset;
  return physicalLocation(file, source, positions, physicalOffset);
}

function addLineToken(lines: Map<number, PPToken[]>, line: number, token: PPToken): void {
  const existing = lines.get(line);
  if (existing) existing.push(token);
  else lines.set(line, [token]);
}

function normalizeDigraphs(lines: Map<number, PPToken[]>): void {
  for (const tokens of lines.values()) {
    for (let index = 0; index < tokens.length;) {
      for (const [spelling, text] of [['%:%:', '##'], ['<:', '['], [':>', ']'], ['<%', '{'], ['%>', '}'], ['%:', '#']] as const) {
        const parts = spelling.length > 2 ? [...spelling] : [spelling.slice(0, 1), spelling.slice(1)];
        const selected = tokens.slice(index, index + parts.length);
        if (selected.length !== parts.length || selected.some((token, part) => token.text !== parts[part] || (part > 0 && (token.leadingSpace || selected[part - 1].logicalEnd !== token.logicalStart)))) continue;
        const first = selected[0], last = selected.at(-1)!;
        tokens.splice(index, parts.length, { ...first, kind: 'symbol', text, spelling, logicalEnd: last.logicalEnd });
        break;
      }
      index++;
    }
  }
}

function tokenizeSource(name: string, source: string): { lines: PPLine[]; eof: Location & { physicalLine: number; physicalColumn: number } } {
  const mapped = translatePhasesOneAndTwo(source);
  const positions = sourcePositions(source);
  const lines = new Map<number, PPToken[]>();
  let leadingSpace = true;
  for (const syntax of scanC(mapped.text)) {
    const spelling = mapped.text.slice(syntax.start, syntax.end);
    if (syntax.kind === 'whitespace' || syntax.kind === 'line-comment' || syntax.kind === 'block-comment') {
      if (syntax.kind === 'block-comment' && syntax.closed === false) {
        const location = syntaxTokenAt(syntax, mapped, source, name, positions);
        failure('UNTERMINATED_COMMENT', 'Comentario de bloque sin cierre */.', location);
      }
      leadingSpace = true;
      continue;
    }
    const physical = syntaxTokenAt(syntax, mapped, source, name, positions);
    const make = (kind: PPToken['kind'], text: string, original: string, logicalStart: number, logicalEnd: number, separated = leadingSpace): PPToken => {
      const span = physicalSpan(mapped, logicalStart, logicalEnd);
      const start = physicalLocation(name, source, positions, span.start);
      return {
        kind, text, spelling: original, at: { file: name, line: start.line, column: start.column }, physicalFile: name,
        physicalOffset: span.start, physicalEndOffset: span.end, physicalLine: start.physicalLine,
        physicalColumn: start.physicalColumn, logicalStart, logicalEnd, leadingSpace: separated,
      };
    };
    if (syntax.kind === 'preprocessor') {
      const directive = /^#[\t \v\f]*([A-Za-z_][A-Za-z_0-9]*)/.exec(spelling);
      const hash = make('symbol', '#', '#', syntax.start, syntax.start + 1);
      addLineToken(lines, syntax.line, hash);
      if (directive) {
        const wordIndex = spelling.indexOf(directive[1], 1);
        const wordOffset = syntax.start + wordIndex;
        const keyword = make('identifier', directive[1], directive[1], wordOffset, wordOffset + directive[1].length, wordOffset > syntax.start + 1);
        addLineToken(lines, syntax.line, keyword);
      }
      leadingSpace = true;
      continue;
    }
    let kind: PPToken['kind'] = syntax.kind;
    let text = spelling;
    if (syntax.kind === 'identifier') text = decodeIdentifier(spelling, physical);
    else if (syntax.kind === 'string' || syntax.kind === 'character') {
      if (syntax.closed === false) failure(syntax.kind === 'string' ? 'UNTERMINATED_STRING' : 'UNTERMINATED_CHARACTER', syntax.kind === 'string' ? 'Literal de cadena sin cierre.' : 'Literal de carácter sin cierre.', physical);
      if (spelling.startsWith('<') && spelling.endsWith('>')) kind = 'header';
      else text = translateLiteralUCNs(spelling, physical);
    }
    const token = make(kind, text, spelling, syntax.start, syntax.end);
    addLineToken(lines, syntax.line, token);
    leadingSpace = false;
  }
  normalizeDigraphs(lines);
  const result = [...lines.entries()].sort(([left], [right]) => left - right).map(([number, tokens]) => ({ number, tokens }));
  const eof = physicalLocation(name, source, positions, source.length);
  return { lines: result, eof };
}

function cloneAt(token: PPToken, at: Location, options: { hideSet?: ReadonlySet<string>; leadingSpace?: boolean; text?: string; kind?: PPToken['kind']; spelling?: string } = {}): PPToken {
  return {
    ...token, at, physicalLine: token.physicalLine, physicalColumn: token.physicalColumn,
    expansionSite: token.expansionSite ?? at,
    hideSet: options.hideSet ?? token.hideSet, leadingSpace: options.leadingSpace ?? token.leadingSpace,
    text: options.text ?? token.text, spelling: options.spelling ?? token.spelling, kind: options.kind ?? token.kind,
  };
}

function mergedHideSet(...sets: (ReadonlySet<string> | undefined)[]): ReadonlySet<string> | undefined {
  const merged = new Set<string>();
  for (const set of sets) if (set) for (const name of set) merged.add(name);
  return merged.size ? merged : undefined;
}

function tokenText(tokens: readonly PPToken[]): string {
  let result = '';
  for (const token of tokens) {
    if (result && token.leadingSpace) result += ' ';
    result += token.text;
  }
  return result;
}

function decodeCQuotedString(token: PPToken): string {
  if (token.kind !== 'string' || !token.text.startsWith('"') || !token.text.endsWith('"')) preprocessError('Se esperaba una cadena C entre comillas.', token.at);
  const body = token.text.slice(1, -1);
  let result = '';
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character !== '\\') { result += character; continue; }
    const escaped = body[++index];
    if (escaped === undefined) preprocessError('Escape incompleto en cadena del preprocesador.', token.at);
    const simple: Record<string, string> = { '"': '"', "'": "'", '?': '?', '\\': '\\', a: '\x07', b: '\x08', f: '\x0c', n: '\n', r: '\r', t: '\t', v: '\x0b' };
    if (Object.hasOwn(simple, escaped)) result += simple[escaped];
    else if (/[0-7]/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /[0-7]/.test(body[index + 1] ?? '')) digits += body[++index];
      result += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
    } else if (escaped === 'x') {
      let digits = '';
      while (/[0-9a-fA-F]/.test(body[index + 1] ?? '')) digits += body[++index];
      if (!digits) preprocessError('Escape hexadecimal sin dígitos en cadena del preprocesador.', token.at);
      result += String.fromCharCode(Number.parseInt(digits, 16) & 0xff);
    } else preprocessError(`Escape no válido en cadena del preprocesador: \\${escaped}.`, token.at);
  }
  return result;
}

function predefinedMacros(at: Location, dateText: string, timeText: string): Map<string, Macro> {
  const macros = new Map<string, Macro>();
  const fixed: Record<string, string> = {
    __STDC__: '1', __STDC_VERSION__: '201112L', __STDC_HOSTED__: '1',
    __STDC_NO_VLA__: '1', __STDC_NO_COMPLEX__: '1', __STDC_NO_ATOMICS__: '1', __STDC_NO_THREADS__: '1',
    __DATE__: quoteC(dateText), __TIME__: quoteC(timeText),
  };
  for (const [name, value] of Object.entries(fixed)) {
    const token: PPToken = { kind: name === '__DATE__' || name === '__TIME__' ? 'string' : 'number', text: value, spelling: value, at, physicalLine: at.line, physicalColumn: at.column, logicalStart: 0, logicalEnd: value.length, leadingSpace: false };
    macros.set(name, { name, variadic: false, replacement: [token], at });
  }
  for (const name of ['__FILE__', '__LINE__']) macros.set(name, { name, variadic: false, replacement: [], at });
  return macros;
}

function syntheticToken(kind: PPToken['kind'], text: string, at: Location, leadingSpace = false, hideSet?: ReadonlySet<string>): PPToken {
  return { kind, text, spelling: text, at, physicalLine: at.line, physicalColumn: at.column, logicalStart: 0, logicalEnd: text.length, leadingSpace, ...(hideSet ? { hideSet } : {}) };
}

function sameMacro(left: Macro, right: Macro): boolean {
  if (left.variadic !== right.variadic || left.parameters?.length !== right.parameters?.length || left.parameters?.some((name, index) => name !== right.parameters?.[index])) return false;
  return left.replacement.length === right.replacement.length && left.replacement.every((token, index) => token.kind === right.replacement[index].kind && token.text === right.replacement[index].text);
}

function parseMacroArguments(tokens: readonly PPToken[], openIndex: number, at: Location, parameters: readonly string[] | undefined): { arguments: PPToken[][]; separators: PPToken[]; end: number } {
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
  preprocessError('Invocación de macro sin paréntesis de cierre.', at);
}

function stringifyArgument(tokens: readonly PPToken[], at: Location, leadingSpace: boolean, hideSet?: ReadonlySet<string>): PPToken {
  let contents = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (index && token.leadingSpace) contents += ' ';
    contents += token.text;
  }
  const escaped = contents.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const text = `"${escaped}"`;
  return syntheticToken('string', text, at, leadingSpace, hideSet);
}

function pastedToken(left: PPToken, right: PPToken, at: Location, hideSet: ReadonlySet<string> | undefined): PPToken {
  const text = left.text + right.text;
  const scanned = [...scanC(text)].filter((token) => token.kind !== 'whitespace');
  if (scanned.length !== 1 || scanned[0].start !== 0 || scanned[0].end !== text.length || scanned[0].closed === false || ['invalid', 'line-comment', 'block-comment', 'preprocessor'].includes(scanned[0].kind)) {
    preprocessError(`El pegado de tokens «${left.text} ## ${right.text}» no forma un token C.`, at, 'INVALID_TOKEN_PASTE');
  }
  const syntax = scanned[0];
  let kind: PPToken['kind'] = syntax.kind;
  let normalized = text;
  if (syntax.kind === 'identifier') normalized = decodeIdentifier(text, at);
  else if (syntax.kind === 'string' || syntax.kind === 'character') normalized = translateLiteralUCNs(text, at);
  return { ...left, kind, text: normalized, spelling: text, at, logicalStart: left.logicalStart, logicalEnd: right.logicalEnd, hideSet, leadingSpace: left.leadingSpace };
}

function stringifyPragmaText(text: string): string[] {
  return text.trim().split(/[\t \v\f\r\n]+/).filter(Boolean);
}

class TranslationPreprocessor {
  readonly context: PPContext;

  constructor(context: PPContext) { this.context = context; }

  private countExpansionWork(amount: number, at: Location): void {
    this.context.metrics.preprocessSteps += amount;
    enforceLimit('maxPreprocessSteps', this.context.metrics.preprocessSteps, this.context.limits.maxPreprocessSteps, at);
  }

  private checkDepth(depth: number, at: Location): void {
    if (depth > MAX_INTERNAL_DEPTH) throw new EngineFailure('LIMIT_EXCEEDED', `Se superó el límite interno de profundidad del preprocesador (${MAX_INTERNAL_DEPTH}).`, at, 'maxDepth', MAX_INTERNAL_DEPTH);
    enforceLimit('maxDepth', depth, this.context.limits.maxDepth, at);
  }

  private expand(tokens: readonly PPToken[], depth = 0): PPToken[] {
    const output: PPToken[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      this.countExpansionWork(1, token.at);
      if (token.kind !== 'identifier' || token.hideSet?.has(token.text)) { output.push(token); index++; continue; }
      const macro = this.context.macros.get(token.text);
      if (!macro) { output.push(token); index++; continue; }
      this.checkDepth(depth + 1, token.at);
      if (macro.name === '__LINE__') {
        output.push(syntheticToken('number', String(token.at.line), token.at, token.leadingSpace, token.hideSet));
        index++;
        continue;
      }
      if (macro.name === '__FILE__') {
        output.push(syntheticToken('string', quoteC(token.at.file), token.at, token.leadingSpace, token.hideSet));
        index++;
        continue;
      }
      if (macro.parameters === undefined) {
        const hideSet = mergedHideSet(token.hideSet, new Set([macro.name]));
        const replacement = macro.replacement.map((part, partIndex) => cloneAt(part, token.at, { hideSet, leadingSpace: partIndex === 0 ? token.leadingSpace : part.leadingSpace }));
        this.countExpansionWork(replacement.length + 1, token.at);
        output.push(...this.expand([...replacement, ...tokens.slice(index + 1)], depth + 1));
        return output;
      }
      if (tokens[index + 1]?.text !== '(') { output.push(token); index++; continue; }
      const invocation = parseMacroArguments(tokens, index + 1, token.at, macro.parameters);
      const fixedCount = macro.parameters.length;
      const rawArguments = invocation.arguments;
      if ((!macro.variadic && rawArguments.length !== fixedCount) || (macro.variadic && rawArguments.length < fixedCount)) {
        preprocessError(`La macro «${macro.name}» recibió ${rawArguments.length} argumentos; esperaba ${macro.variadic ? `al menos ${fixedCount}` : fixedCount}.`, token.at);
      }
      const argumentMap = new Map<string, PPToken[]>();
      for (let argument = 0; argument < fixedCount; argument++) argumentMap.set(macro.parameters[argument], rawArguments[argument] ?? []);
      if (macro.variadic) {
        const variadic: PPToken[] = [];
        for (let argument = fixedCount; argument < rawArguments.length; argument++) {
          if (argument > fixedCount) variadic.push(invocation.separators[argument - 1] ?? syntheticToken('symbol', ',', token.at));
          variadic.push(...rawArguments[argument]);
        }
        argumentMap.set('__VA_ARGS__', variadic);
      }
      const expandedArguments = new Map<string, PPToken[]>();
      for (const [name, argument] of argumentMap) {
        const usedWithoutStringizeOrPaste = macro.replacement.some((part, partIndex) => part.kind === 'identifier' && part.text === name
          && macro.replacement[partIndex - 1]?.text !== '#' && macro.replacement[partIndex - 1]?.text !== '##' && macro.replacement[partIndex + 1]?.text !== '##');
        if (usedWithoutStringizeOrPaste) expandedArguments.set(name, this.expand(argument, depth + 1));
      }
      const hideSet = mergedHideSet(token.hideSet, new Set([macro.name]));
      const replacementItems: (PPToken[] | 'paste')[] = [];
      for (let partIndex = 0; partIndex < macro.replacement.length; partIndex++) {
        const part = macro.replacement[partIndex];
        if (part.text === '#' && macro.replacement[partIndex + 1]?.kind === 'identifier') {
          const parameter = macro.replacement[partIndex + 1].text;
          const raw = argumentMap.get(parameter);
          if (raw) {
            replacementItems.push([stringifyArgument(raw, token.at, partIndex === 0 ? token.leadingSpace : part.leadingSpace, hideSet)]);
            partIndex++;
            continue;
          }
        }
        if (part.text === '##') { replacementItems.push('paste'); continue; }
        if (part.kind === 'identifier' && argumentMap.has(part.text)) {
          const adjacentPaste = macro.replacement[partIndex - 1]?.text === '##' || macro.replacement[partIndex + 1]?.text === '##';
          const selected = adjacentPaste ? argumentMap.get(part.text)! : expandedArguments.get(part.text)!;
          replacementItems.push(selected.map((value, selectedIndex) => cloneAt(value, token.at, { hideSet: mergedHideSet(value.hideSet, hideSet), leadingSpace: partIndex === 0 && selectedIndex === 0 ? token.leadingSpace : value.leadingSpace })));
        } else replacementItems.push([cloneAt(part, token.at, { hideSet, leadingSpace: partIndex === 0 ? token.leadingSpace : part.leadingSpace })]);
      }
      for (let itemIndex = 0; itemIndex < replacementItems.length;) {
        if (replacementItems[itemIndex] !== 'paste') { itemIndex++; continue; }
        if (itemIndex === 0 || itemIndex === replacementItems.length - 1) preprocessError(`La macro «${macro.name}» tiene ## en un extremo de su reemplazo.`, token.at);
        const left = replacementItems[itemIndex - 1] as PPToken[];
        const right = replacementItems[itemIndex + 1] as PPToken[];
        let combined: PPToken[];
        if (!left.length) combined = right;
        else if (!right.length) combined = left;
        else combined = [...left.slice(0, -1), pastedToken(left.at(-1)!, right[0], token.at, hideSet), ...right.slice(1)];
        replacementItems.splice(itemIndex - 1, 3, combined);
        itemIndex = Math.max(0, itemIndex - 1);
      }
      const replacement = replacementItems.flatMap((item) => item === 'paste' ? [] : item);
      this.countExpansionWork(replacement.length + rawArguments.reduce((total, argument) => total + argument.length, 0) + 1, token.at);
      output.push(...this.expand([...replacement, ...tokens.slice(invocation.end + 1)], depth + 1));
      return output;
    }
    return output;
  }

  private stringifyCondition(tokens: readonly PPToken[]): PPToken[] {
    const protectedTokens: PPToken[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== 'identifier' || token.text !== 'defined') { protectedTokens.push(token); continue; }
      let name: PPToken | undefined;
      let end = index;
      if (tokens[index + 1]?.text === '(') {
        name = tokens[index + 2];
        if (!name || name.kind !== 'identifier' || tokens[index + 3]?.text !== ')') preprocessError('El operador defined requiere un identificador opcionalmente entre paréntesis.', token.at);
        end = index + 3;
      } else {
        name = tokens[index + 1];
        if (!name || name.kind !== 'identifier') preprocessError('El operador defined requiere un identificador.', token.at);
        end = index + 1;
      }
      protectedTokens.push(syntheticToken('number', this.context.macros.has(name.text) ? '1' : '0', token.at, token.leadingSpace));
      index = end;
    }
    const expanded = this.expand(protectedTokens);
    return expanded.map((token) => token.kind === 'identifier' ? cloneAt(token, token.at, { kind: 'number', text: '0', spelling: '0' }) : token);
  }

  private evaluateIf(tokens: readonly PPToken[], at: Location): boolean {
    if (!tokens.length) preprocessError('La directiva #if requiere una expresión.', at);
    const expanded = this.stringifyCondition(tokens);
    return evaluatePreprocessorExpression(expanded, this.context.limits);
  }

  private parsePragma(text: string, at: Location, currentFile: string): void {
    const words = stringifyPragmaText(text);
    if (words.length === 1 && words[0] === 'once') { this.context.onceFiles.add(currentFile); return; }
    if (words.length === 3 && words[0] === 'STDC' && ['FP_CONTRACT', 'FENV_ACCESS', 'CX_LIMITED_RANGE'].includes(words[1]) && ['ON', 'OFF', 'DEFAULT'].includes(words[2])) return;
    preprocessError(`Pragma no implementado: «${text.trim()}».`, at, 'UNSUPPORTED_FEATURE');
  }

  private applyPragmaOperator(tokens: readonly PPToken[], currentFile: string): PPToken[] {
    const result: PPToken[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind !== 'identifier' || token.text !== '_Pragma') { result.push(token); continue; }
      if (tokens[index + 1]?.text !== '(' || tokens[index + 2]?.kind !== 'string' || tokens[index + 3]?.text !== ')') preprocessError('_Pragma requiere una cadena entre paréntesis.', token.at);
      this.parsePragma(decodeCQuotedString(tokens[index + 2]), token.at, currentFile);
      index += 3;
    }
    return result;
  }

  private includeFile(requested: string, angled: boolean, includingFile: string, at: Location): { name: string; source: string } {
    const candidates: string[] = [];
    if (!angled) candidates.push(joinVirtualPath(parentDirectory(includingFile), requested, at));
    candidates.push(joinVirtualPath('', requested, at));
    for (const candidate of candidates) {
      const source = this.context.files.get(candidate);
      if (source !== undefined) return { name: candidate, source };
    }
    const standard = getStandardHeader(requested);
    if (standard !== undefined) return { name: requested, source: standard };
    preprocessError(`No se encontró el header virtual «${requested}».`, at, 'INCLUDE_NOT_FOUND');
  }

  private parseInclude(tokens: readonly PPToken[], includingFile: string, at: Location, depth: number): PPToken[] {
    const expanded = this.expand(tokens);
    if (!expanded.length) preprocessError('#include requiere el nombre de un header.', at);
    let requested: string;
    let angled = false;
    const first = expanded[0];
    if (first.kind === 'header') { requested = first.text.slice(1, -1); angled = true; if (expanded.length !== 1) preprocessError('Tokens sobrantes después del nombre del header.', expanded[1].at); }
    else if (first.kind === 'string') { requested = decodeCQuotedString(first); if (expanded.length !== 1) preprocessError('Tokens sobrantes después del nombre del header.', expanded[1].at); }
    else if (first.text === '<') {
      const close = expanded.findIndex((token, index) => index > 0 && token.text === '>');
      if (close < 0) preprocessError('Header angular sin «>».', first.at);
      requested = expanded.slice(1, close).map((token) => token.text).join('');
      angled = true;
      if (expanded.length !== close + 1) preprocessError('Tokens sobrantes después del nombre del header.', expanded[close + 1].at);
    } else preprocessError('#include requiere una cadena o un header entre «<» y «>».', first.at);
    if (!requested || requested.includes('\0')) preprocessError('El nombre del header está vacío o contiene NUL.', first.at);
    this.countExpansionWork(1, at);
    const target = this.includeFile(requested, angled, includingFile, at);
    return this.processFile(target.name, target.source, depth + 1, at).tokens;
  }

  private defineMacro(tokens: readonly PPToken[], at: Location): void {
    const nameToken = tokens[0];
    if (!nameToken || nameToken.kind !== 'identifier') preprocessError('#define requiere un nombre de macro.', at);
    const name = nameToken.text;
    let cursor = 1;
    let parameters: string[] | undefined;
    let variadic = false;
    if (tokens[cursor]?.text === '(' && !tokens[cursor].leadingSpace) {
      parameters = [];
      cursor++;
      if (tokens[cursor]?.text !== ')') {
        while (cursor < tokens.length) {
          if (tokens[cursor].text === '...') { variadic = true; cursor++; if (tokens[cursor]?.text !== ')') preprocessError('... debe ser el último parámetro de una macro variádica.', tokens[cursor]?.at ?? at); break; }
          const parameter = tokens[cursor];
          if (parameter.kind !== 'identifier' || parameter.text === '__VA_ARGS__') preprocessError('Se esperaba el nombre de un parámetro de macro.', parameter.at);
          if (parameters.includes(parameter.text)) preprocessError(`Parámetro de macro duplicado: «${parameter.text}».`, parameter.at);
          parameters.push(parameter.text);
          cursor++;
          if (tokens[cursor]?.text === ')') break;
          if (tokens[cursor]?.text === '...') { variadic = true; cursor++; if (tokens[cursor]?.text !== ')') preprocessError('... debe ser el último parámetro de una macro variádica.', tokens[cursor]?.at ?? at); break; }
          if (tokens[cursor]?.text !== ',') preprocessError('Se esperaba «,» o «)» en los parámetros de macro.', tokens[cursor]?.at ?? at);
          cursor++;
        }
      }
      if (tokens[cursor]?.text !== ')') preprocessError('Lista de parámetros de macro sin «)».', tokens[cursor]?.at ?? at);
      cursor++;
    }
    const replacement = tokens.slice(cursor);
    for (let index = 0; index < replacement.length; index++) {
      if (replacement[index].text === '##' && (index === 0 || index === replacement.length - 1)) preprocessError('## no puede aparecer al inicio ni al final del reemplazo de macro.', replacement[index].at);
      if (replacement[index].text === '#' && parameters !== undefined) {
        const next = replacement[index + 1];
        if (!next || next.kind !== 'identifier' || !(parameters.includes(next.text) || (variadic && next.text === '__VA_ARGS__'))) preprocessError('# debe preceder un parámetro de la macro.', replacement[index].at);
      }
    }
    const macro: Macro = { name, ...(parameters === undefined ? {} : { parameters }), variadic, replacement, at: nameToken.at };
    const previous = this.context.macros.get(name);
    if (previous && !sameMacro(previous, macro)) preprocessError(`Redefinición incompatible de la macro «${name}».`, nameToken.at);
    this.context.macros.set(name, macro);
  }

  private handleDirective(directive: string, rest: readonly PPToken[], file: string, at: Location, depth: number, conditionalStack: Conditional[], activeBefore: boolean): { output: PPToken[]; lineOverride?: { line: number; file: string; nextPhysicalLine: number } } {
    const output: PPToken[] = [];
    if (!directive) return { output };
    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
      this.checkDepth(conditionalStack.length + 1, at);
      const parentActive = activeBefore;
      let condition = false;
      if (parentActive) {
        if (directive === 'if') condition = this.evaluateIf(rest, at);
        else {
          if (!rest[0] || rest[0].kind !== 'identifier' || rest.length !== 1) preprocessError(`#${directive} requiere un único nombre de macro.`, at);
          condition = this.context.macros.has(rest[0].text);
          if (directive === 'ifndef') condition = !condition;
        }
      }
      conditionalStack.push({ parentActive, active: parentActive && condition, branchTaken: parentActive && condition, sawElse: false, at });
      return { output };
    }
    if (directive === 'elif') {
      const frame = conditionalStack.at(-1);
      if (!frame) preprocessError('#elif sin #if correspondiente.', at);
      if (frame.sawElse) preprocessError('#elif después de #else.', at);
      const condition = frame.parentActive && !frame.branchTaken ? this.evaluateIf(rest, at) : false;
      frame.active = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken ||= condition;
      return { output };
    }
    if (directive === 'else') {
      const frame = conditionalStack.at(-1);
      if (!frame) preprocessError('#else sin #if correspondiente.', at);
      if (frame.sawElse) preprocessError('Más de un #else para la misma condición.', at);
      if (rest.length) preprocessError('Tokens sobrantes después de #else.', rest[0].at);
      frame.sawElse = true;
      frame.active = frame.parentActive && !frame.branchTaken;
      frame.branchTaken = true;
      return { output };
    }
    if (directive === 'endif') {
      if (!conditionalStack.length) preprocessError('#endif sin #if correspondiente.', at);
      if (rest.length) preprocessError('Tokens sobrantes después de #endif.', rest[0].at);
      conditionalStack.pop();
      return { output };
    }
    if (!activeBefore) return { output };
    if (directive === 'define') { this.defineMacro(rest, at); return { output }; }
    if (directive === 'undef') {
      if (rest.length !== 1 || rest[0].kind !== 'identifier') preprocessError('#undef requiere un único nombre de macro.', at);
      this.context.macros.delete(rest[0].text);
      return { output };
    }
    if (directive === 'include') return { output: this.parseInclude(rest, file, at, depth) };
    if (directive === 'error') {
      const expanded = this.expand(rest);
      preprocessError(tokenText(expanded) || '#error', at, 'PREPROCESSOR_ERROR');
    }
    if (directive === 'line') {
      const expanded = this.expand(rest);
      const number = expanded[0];
      if (!number || number.kind !== 'number' || !/^(?:0|[1-9][0-9]*)$/.test(number.text) || expanded.length > 2) preprocessError('#line requiere un número decimal positivo y un nombre de archivo opcional.', number?.at ?? at);
      const requested = BigInt(number.text);
      if (requested < 1n || requested > 2147483647n) preprocessError('#line debe estar entre 1 y 2147483647.', number.at);
      let logicalFile = at.file;
      if (expanded[1]) {
        if (expanded[1].kind !== 'string' || expanded.length !== 2) preprocessError('#line admite un nombre de archivo opcional entre comillas.', expanded[1].at);
        logicalFile = decodeCQuotedString(expanded[1]);
      }
      const physicalEnd = Math.max(...rest.map((token) => token.physicalLine));
      return { output, lineOverride: { line: Number(requested), file: logicalFile, nextPhysicalLine: physicalEnd + 1 } };
    }
    if (directive === 'pragma') { this.parsePragma(tokenText(rest), at, file); return { output }; }
    preprocessError(`Directiva de preprocesador no implementada: #${directive}.`, at, 'UNSUPPORTED_FEATURE');
  }

  private active(conditionalStack: readonly Conditional[]): boolean {
    return conditionalStack.length === 0 || conditionalStack.at(-1)!.active;
  }

  private processFile(file: string, source: string, depth: number, includeAt: Location): { tokens: PPToken[]; eof: Location } {
    this.checkDepth(depth, includeAt);
    this.countExpansionWork(1, includeAt);
    if (this.context.onceFiles.has(file)) return { tokens: [], eof: { file, line: 1, column: 1 } };
    const scanned = tokenizeSource(file, source);
    let logicalFile = file;
    let logicalOffset = 0;
    const output: PPToken[] = [];
    let pending: PPToken[] = [];
    const conditionalStack: Conditional[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      const expanded = this.expand(pending);
      output.push(...this.applyPragmaOperator(expanded, file));
      pending = [];
    };
    for (const line of scanned.lines) {
      const tokens = line.tokens.map((token) => ({ ...token, at: { file: logicalFile, line: token.physicalLine + logicalOffset, column: token.physicalColumn } }));
      this.countExpansionWork(Math.max(1, tokens.length), tokens[0]?.at ?? includeAt);
      const isDirective = tokens[0]?.text === '#';
      if (!isDirective) {
        if (this.active(conditionalStack)) pending.push(...tokens);
        continue;
      }
      flush();
      const head = tokens[1];
      if (head && head.kind !== 'identifier') {
        if (this.active(conditionalStack)) preprocessError('Se esperaba el nombre de una directiva después de «#».', head.at);
        continue;
      }
      const directive = head?.kind === 'identifier' ? head.text : '';
      const rest = head ? tokens.slice(2) : [];
      const at = tokens[0].at;
      const handled = this.handleDirective(directive, rest, file, at, depth, conditionalStack, this.active(conditionalStack));
      output.push(...handled.output);
      if (handled.lineOverride) {
        logicalOffset = handled.lineOverride.line - handled.lineOverride.nextPhysicalLine;
        logicalFile = handled.lineOverride.file;
      }
    }
    flush();
    if (conditionalStack.length) preprocessError('Falta #endif para una condición iniciada aquí.', conditionalStack.at(-1)!.at);
    const eof: Location = { file: logicalFile, line: scanned.eof.physicalLine + logicalOffset, column: scanned.eof.physicalColumn };
    return { tokens: output, eof };
  }

  run(name: string, source: string): { tokens: PPToken[]; eof: Location } {
    return this.processFile(name, source, 0, { file: name, line: 1, column: 1 });
  }
}

interface PPValue { readonly value: bigint; readonly unsigned: boolean }
type PPExpression =
  | { readonly kind: 'value'; readonly value: PPValue }
  | { readonly kind: 'unary'; readonly operator: string; readonly operand: PPExpression; readonly at: Location }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: PPExpression; readonly right: PPExpression; readonly at: Location }
  | { readonly kind: 'conditional'; readonly condition: PPExpression; readonly then: PPExpression; readonly otherwise: PPExpression; readonly at: Location };

const ppPrecedence: Readonly<Record<string, number>> = Object.freeze({
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
});
const ppSignedMin = -(1n << 63n);
const ppSignedMax = (1n << 63n) - 1n;

class PreprocessorExpressionParser {
  private readonly tokens: readonly PPToken[];
  private readonly limits: PrepareLimits;
  private cursor = 0;

  constructor(tokens: readonly PPToken[], limits: PrepareLimits) { this.tokens = tokens; this.limits = limits; }

  private peek(): PPToken | undefined { return this.tokens[this.cursor]; }
  private take(text?: string): PPToken | undefined {
    const token = this.peek();
    if (!token || (text !== undefined && token.text !== text)) return undefined;
    this.cursor++;
    return token;
  }
  private expect(text: string): PPToken {
    const token = this.take(text);
    if (!token) preprocessError(`Se esperaba «${text}» en la expresión de #if.`, this.peek()?.at ?? this.tokens.at(-1)?.at ?? { file: 'main.c', line: 1, column: 1 });
    return token;
  }
  private checkDepth(depth: number, at: Location): void {
    if (depth > MAX_INTERNAL_DEPTH) preprocessError('La expresión de #if excede la profundidad interna admitida.', at, 'LIMIT_EXCEEDED');
    enforceLimit('maxDepth', depth, this.limits.maxDepth, at);
  }

  parse(): PPExpression {
    if (!this.tokens.length) preprocessError('Expresión #if vacía.', { file: 'main.c', line: 1, column: 1 });
    const expression = this.parseConditional(0);
    if (this.peek()) preprocessError(`Token no válido «${this.peek()!.text}» en la expresión de #if.`, this.peek()!.at);
    return expression;
  }

  private parseConditional(depth: number): PPExpression {
    const at = this.peek()?.at ?? this.tokens.at(-1)!.at;
    this.checkDepth(depth + 1, at);
    const condition = this.parseBinary(1, depth + 1);
    if (!this.take('?')) return condition;
    const then = this.parseConditional(depth + 1);
    this.expect(':');
    const otherwise = this.parseConditional(depth + 1);
    return { kind: 'conditional', condition, then, otherwise, at };
  }

  private parseBinary(minimum: number, depth: number): PPExpression {
    const at = this.peek()?.at ?? this.tokens.at(-1)!.at;
    this.checkDepth(depth + 1, at);
    let left = this.parseUnary(depth + 1);
    for (;;) {
      const operator = this.peek()?.text;
      const precedence = operator === undefined ? undefined : ppPrecedence[operator];
      if (precedence === undefined || precedence < minimum) break;
      const operatorToken = this.take()!;
      const right = this.parseBinary(precedence + 1, depth + 1);
      left = { kind: 'binary', operator: operatorToken.text, left, right, at: operatorToken.at };
    }
    return left;
  }

  private parseUnary(depth: number): PPExpression {
    const token = this.peek();
    if (token && ['+', '-', '!', '~'].includes(token.text)) {
      this.cursor++;
      this.checkDepth(depth + 1, token.at);
      return { kind: 'unary', operator: token.text, operand: this.parseUnary(depth + 1), at: token.at };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): PPExpression {
    const token = this.take();
    if (!token) preprocessError('Falta un operando en la expresión de #if.', this.tokens.at(-1)?.at ?? { file: 'main.c', line: 1, column: 1 });
    if (token.text === '(') {
      this.checkDepth(depth + 1, token.at);
      const nested = this.parseConditional(depth + 1);
      this.expect(')');
      return nested;
    }
    if (token.kind !== 'number' && token.kind !== 'character') preprocessError(`Se esperaba una constante entera en #if; se encontró «${token.text}».`, token.at);
    const literal = parseLiteral(token.text, token.at);
    if (typeof literal.value !== 'bigint') preprocessError('La expresión #if solo admite constantes enteras.', token.at);
    return { kind: 'value', value: { value: literal.value, unsigned: String(literal.type).startsWith('unsigned') } };
  }
}

function ppTruthy(value: PPValue): boolean { return value.value !== 0n; }
function ppExpressionUnsigned(expression: PPExpression): boolean {
  if (expression.kind === 'value') return expression.value.unsigned;
  if (expression.kind === 'unary') return expression.operator === '!' ? false : ppExpressionUnsigned(expression.operand);
  if (expression.kind === 'conditional') return ppExpressionUnsigned(expression.then) || ppExpressionUnsigned(expression.otherwise);
  if (['&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(expression.operator)) return false;
  if (expression.operator === '<<' || expression.operator === '>>') return ppExpressionUnsigned(expression.left);
  return ppExpressionUnsigned(expression.left) || ppExpressionUnsigned(expression.right);
}
function ppAsUnsigned(value: PPValue): bigint { return BigInt.asUintN(64, value.value); }
function ppUsual(left: PPValue, right: PPValue): { left: bigint; right: bigint; unsigned: boolean } {
  const unsigned = left.unsigned || right.unsigned;
  return unsigned
    ? { left: ppAsUnsigned(left), right: ppAsUnsigned(right), unsigned }
    : { left: left.value, right: right.value, unsigned };
}
function ppResult(value: bigint, unsigned: boolean, at: Location): PPValue {
  if (unsigned) return { value: BigInt.asUintN(64, value), unsigned: true };
  if (value < ppSignedMin || value > ppSignedMax) preprocessError('Desbordamiento signed en una expresión constante de #if.', at, 'INVALID_PREPROCESSOR_EXPRESSION');
  return { value, unsigned: false };
}

function evaluatePreprocessorExpression(tokens: readonly PPToken[], limits: PrepareLimits): boolean {
  const tree = new PreprocessorExpressionParser(tokens, limits).parse();
  const evaluate = (expression: PPExpression, active = true): PPValue => {
    if (!active) return { value: 0n, unsigned: false };
    if (expression.kind === 'value') return expression.value;
    if (expression.kind === 'unary') {
      const operand = evaluate(expression.operand);
      if (expression.operator === '!') return { value: ppTruthy(operand) ? 0n : 1n, unsigned: false };
      if (expression.operator === '+') return operand;
      if (expression.operator === '-') return ppResult(-operand.value, operand.unsigned, expression.at);
      if (expression.operator === '~') return ppResult(~operand.value, operand.unsigned, expression.at);
      return preprocessError(`Operador unario no admitido en #if: ${expression.operator}.`, expression.at);
    }
    if (expression.kind === 'conditional') {
      const condition = evaluate(expression.condition);
      const selected = ppTruthy(condition) ? evaluate(expression.then) : evaluate(expression.otherwise);
      return ppResult(selected.value, ppExpressionUnsigned(expression), expression.at);
    }
    const left = evaluate(expression.left);
    if (expression.operator === '&&') return ppTruthy(left) ? { value: ppTruthy(evaluate(expression.right)) ? 1n : 0n, unsigned: false } : { value: 0n, unsigned: false };
    if (expression.operator === '||') return ppTruthy(left) ? { value: 1n, unsigned: false } : { value: ppTruthy(evaluate(expression.right)) ? 1n : 0n, unsigned: false };
    const right = evaluate(expression.right);
    const operands = ppUsual(left, right);
    const a = operands.left, b = operands.right, unsigned = operands.unsigned;
    switch (expression.operator) {
      case '+': return ppResult(a + b, unsigned, expression.at);
      case '-': return ppResult(a - b, unsigned, expression.at);
      case '*': return ppResult(a * b, unsigned, expression.at);
      case '/':
        if (b === 0n) preprocessError('División por cero en una expresión #if.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        if (!unsigned && a === ppSignedMin && b === -1n) preprocessError('Desbordamiento en división de una expresión #if.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        return ppResult(a / b, unsigned, expression.at);
      case '%':
        if (b === 0n) preprocessError('Resto por cero en una expresión #if.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        return ppResult(a % b, unsigned, expression.at);
      case '<<': case '>>': {
        if (right.value < 0n || right.value >= 64n) preprocessError('Desplazamiento fuera de rango en una expresión #if.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        const shift = Number(right.value);
        if (expression.operator === '>>') return ppResult((unsigned ? BigInt.asUintN(64, a) : a) >> BigInt(shift), unsigned, expression.at);
        if (!unsigned && (a < 0n || (a << BigInt(shift)) > ppSignedMax)) preprocessError('Desplazamiento signed fuera de rango en una expresión #if.', expression.at, 'INVALID_PREPROCESSOR_EXPRESSION');
        return ppResult(a << BigInt(shift), unsigned, expression.at);
      }
      case '&': return ppResult(a & b, unsigned, expression.at);
      case '^': return ppResult(a ^ b, unsigned, expression.at);
      case '|': return ppResult(a | b, unsigned, expression.at);
      case '==': return { value: a === b ? 1n : 0n, unsigned: false };
      case '!=': return { value: a !== b ? 1n : 0n, unsigned: false };
      case '<': return { value: a < b ? 1n : 0n, unsigned: false };
      case '<=': return { value: a <= b ? 1n : 0n, unsigned: false };
      case '>': return { value: a > b ? 1n : 0n, unsigned: false };
      case '>=': return { value: a >= b ? 1n : 0n, unsigned: false };
      default: return preprocessError(`Operador binario no admitido en #if: ${expression.operator}.`, expression.at);
    }
  };
  return ppTruthy(evaluate(tree));
}

export function preprocessProject(project: SourceProject, limits: PrepareLimits, metrics: EngineMetrics): readonly PreprocessedUnit[] {
  const fallback = typeof project?.entry === 'string' && project.entry ? project.entry : 'main.c';
  const location: Location = { file: fallback, line: 1, column: 1 };
  if (!project || typeof project !== 'object' || typeof project.entry !== 'string' || !project.entry || !Array.isArray(project.files)) {
    preprocessError('Se requiere un proyecto con entry y una lista de fuentes.', location, 'INVALID_PROJECT');
  }
  const files = new Map<string, string>();
  let sourceChars = 0;
  for (const file of project.files) {
    if (!file || typeof file.name !== 'string' || !file.name || typeof file.source !== 'string') preprocessError('Cada fuente debe tener name y source de tipo string.', location, 'INVALID_PROJECT');
    const name = normalizeVirtualPath(file.name, location);
    if (files.has(name)) preprocessError(`Nombre de fuente duplicado: «${name}».`, { file: name, line: 1, column: 1 }, 'INVALID_PROJECT');
    files.set(name, file.source);
    sourceChars += file.source.length;
  }
  const entry = normalizeVirtualPath(project.entry, location);
  if (!files.has(entry)) preprocessError(`El archivo de entrada «${entry}» no existe entre las fuentes.`, location, 'INVALID_PROJECT');
  metrics.sourceChars = sourceChars;
  enforceLimit('maxSourceChars', sourceChars, limits.maxSourceChars, { file: entry, line: 1, column: 1 });
  const requestedUnits = (project as SourceProject & { translationUnits?: readonly string[] }).translationUnits;
  if (requestedUnits !== undefined && (!Array.isArray(requestedUnits) || requestedUnits.length === 0)) preprocessError('translationUnits debe ser una lista no vacía de nombres de fuentes.', location, 'INVALID_PROJECT');
  const unitNames = requestedUnits ?? [entry];
  const date = new Date();
  const dateText = `${monthNames[date.getMonth()]} ${date.getDate() < 10 ? ` ${date.getDate()}` : date.getDate()} ${date.getFullYear()}`;
  const timeText = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  const units: PreprocessedUnit[] = [];
  for (const requestedName of unitNames) {
    const name = normalizeVirtualPath(requestedName, location);
    const source = files.get(name);
    if (source === undefined) preprocessError(`La unidad de traducción «${name}» no existe entre las fuentes.`, location, 'INVALID_PROJECT');
    const start: Location = { file: name, line: 1, column: 1 };
    const context: PPContext = {
      macros: predefinedMacros(start, dateText, timeText), files, onceFiles: new Set(), limits, metrics,
      dateText, timeText,
    };
    const preprocessor = new TranslationPreprocessor(context);
    const result = preprocessor.run(name, source);
    const tokens: Token[] = [];
    for (const token of result.tokens) {
      if (token.kind === 'header') preprocessError('Un nombre de header quedó fuera de una directiva #include.', token.at);
      const parsed = lexPreprocessingToken(token.kind, token.text, token.at);
      metrics.tokenCount++;
      enforceLimit('maxTokens', metrics.tokenCount, limits.maxTokens, token.at);
      tokens.push(parsed);
    }
    tokens.push({ kind: 'eof', text: '', ...result.eof });
    units.push({ name, tokens });
  }
  return units;
}


