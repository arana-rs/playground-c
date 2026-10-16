import { C_KEYWORDS, C_TYPE_KEYWORDS, scanC } from '@playground/c11-engine/syntax';

export type HighlightKind = 'plain' | 'keyword' | 'type' | 'comment' | 'number' | 'string' | 'function' | 'preprocessor' | 'operator' | 'punctuation';
export interface HighlightToken { start: number; end: number; kind: HighlightKind }

const keywords = new Set<string>(C_KEYWORDS);
const types = new Set<string>(C_TYPE_KEYWORDS);

/** Classify shared C tokens without parsing or rewriting incomplete editor text. */
export function highlightC(source: string): HighlightToken[] {
  const tokens = [...scanC(source)];
  const nextCode = new Array<number>(tokens.length);
  let next = -1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    nextCode[index] = next;
    if (!['whitespace', 'line-comment', 'block-comment'].includes(tokens[index].kind)) next = index;
  }
  const highlighted: HighlightToken[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const text = source.slice(token.start, token.end);
    let kind: HighlightKind = 'plain';
    if (token.kind === 'line-comment' || token.kind === 'block-comment') kind = 'comment';
    else if (token.kind === 'string' || token.kind === 'character') kind = 'string';
    else if (token.kind === 'number') kind = 'number';
    else if (token.kind === 'preprocessor') kind = 'preprocessor';
    else if (token.kind === 'identifier') {
      if (types.has(text)) kind = 'type';
      else if (keywords.has(text)) kind = 'keyword';
      else if (nextCode[index] !== -1 && source.slice(tokens[nextCode[index]].start, tokens[nextCode[index]].end) === '(') kind = 'function';
    } else if (token.kind === 'symbol') kind = /^[{}()[\];,.]$/.test(text) ? 'punctuation' : 'operator';
    const previous = highlighted.at(-1);
    if (previous?.kind === kind) previous.end = token.end;
    else highlighted.push({ start: token.start, end: token.end, kind });
  }
  return highlighted;
}
