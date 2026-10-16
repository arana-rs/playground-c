import { scanC } from '@playground/c11-engine/syntax';
import type { SyntaxToken } from '@playground/c11-engine/syntax';

export type CContextKind = 'code' | 'string' | 'character' | 'line-comment' | 'block-comment';

export interface CContext {
  kind: CContextKind;
  escaped: boolean;
}

/** Share lexical rules while keeping C's physical-line splice behavior for edits. */
export function getCContext(text: string, position: number): CContext {
  const logical = text.slice(0, position).replace(/\\(?:\r\n|\n|\r)/g, '');
  let last: SyntaxToken | undefined;
  for (const token of scanC(logical)) last = token;
  let kind: CContextKind = 'code';
  if (last?.closed === false) {
    if (last.kind === 'line-comment' || last.kind === 'block-comment' || last.kind === 'character') kind = last.kind;
    // Angle-bracket include names keep the editor's existing code context.
    else if (last.kind === 'string' && logical[last.start] !== '<') kind = 'string';
  }
  let backslashes = 0;
  for (let index = logical.length - 1; index >= 0 && logical[index] === '\\'; index--) backslashes++;
  return { kind, escaped: (kind === 'code' || kind === 'string' || kind === 'character') && backslashes % 2 === 1 };
}
