import { scanC } from '../syntax.ts';
import { failure, type Location } from './internal.ts';
import { decodeIdentifier, physicalLocation, physicalSpan, sourcePositions, syntaxTokenAt, translateLiteralUCNs, translatePhasesOneAndTwo } from './preprocessor-source.ts';
import type { PPLine, PPToken } from './preprocessor-types.ts';

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

export function tokenizeSource(name: string, source: string, captureSourceSpans: boolean): { lines: PPLine[]; eof: Location & { physicalLine: number; physicalColumn: number } } {
  const mapped = translatePhasesOneAndTwo(source);
  const positions = sourcePositions(source);
  const lines = new Map<number, PPToken[]>();
  let leadingSpace = true;
  for (const syntax of scanC(mapped.text)) {
    const spelling = mapped.text.slice(syntax.start, syntax.end);
    if (syntax.kind === 'whitespace' || syntax.kind === 'line-comment' || syntax.kind === 'block-comment') {
      if (syntax.kind === 'block-comment' && syntax.closed === false) {
        const location = syntaxTokenAt(syntax, mapped, source, name, positions);
        failure('UNTERMINATED_COMMENT', 'Unterminated block comment */.', location);
      }
      leadingSpace = true;
      continue;
    }
    const physical = syntaxTokenAt(syntax, mapped, source, name, positions);
    const make = (kind: PPToken['kind'], text: string, original: string, logicalStart: number, logicalEnd: number, separated = leadingSpace): PPToken => {
      const span = physicalSpan(mapped, logicalStart, logicalEnd);
      const start = physicalLocation(name, source, positions, span.start);
      const end = captureSourceSpans ? physicalLocation(name, source, positions, span.end) : undefined;
      return {
        kind, text, spelling: original, at: { file: name, line: start.line, column: start.column }, physicalFile: name,
        physicalOffset: span.start,
        ...(captureSourceSpans ? { physicalEndOffset: span.end } : {}),
        physicalLine: start.physicalLine,
        physicalColumn: start.physicalColumn,
        ...(end ? { physicalEndLine: end.physicalLine, physicalEndColumn: end.physicalColumn } : {}),
        logicalStart, logicalEnd, leadingSpace: separated,
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
      if (syntax.closed === false) failure(syntax.kind === 'string' ? 'UNTERMINATED_STRING' : 'UNTERMINATED_CHARACTER', syntax.kind === 'string' ? 'Unterminated string literal.' : 'Unterminated character literal.', physical);
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
