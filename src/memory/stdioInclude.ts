import { scanC } from '@playground/c11-engine/syntax';
import type { SyntaxToken } from '@playground/c11-engine/syntax';

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

function nextDirectiveToken(source: string, tokens: readonly SyntaxToken[], start: number): number {
  let previousEnd = start === 0 ? 0 : tokens[start - 1].end;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (hasUnsplicedNewline(source, previousEnd, token.start)) return -1;
    if (token.kind === 'whitespace' || token.kind === 'block-comment') {
      if (hasUnsplicedNewline(source, token.start, token.end)) return -1;
      previousEnd = token.end;
      continue;
    }
    return index;
  }
  return -1;
}

/** Detect a direct stdio.h include in source text, ignoring comments and literals. */
export function hasDirectStdioInclude(source: string): boolean {
  const tokens = [...scanC(source)];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'preprocessor') continue;

    const directive = source.slice(token.start, token.end);
    let includeIndex = /^#[\t \v\f]*include$/.test(directive) ? index : -1;
    if (includeIndex === -1 && /^#[\t \v\f]*$/.test(directive)) {
      const next = nextDirectiveToken(source, tokens, index + 1);
      if (next !== -1 && tokens[next].kind === 'identifier' && source.slice(tokens[next].start, tokens[next].end) === 'include') {
        includeIndex = next;
      }
    }
    if (includeIndex === -1) continue;

    const headerIndex = nextDirectiveToken(source, tokens, includeIndex + 1);
    if (headerIndex === -1) continue;
    const header = tokens[headerIndex];
    const spelling = source.slice(header.start, header.end);
    if (header.kind === 'string' && (spelling === '<stdio.h>' || spelling === '"stdio.h"')) return true;

    // A comment between # and include is valid C, but the tolerant scanner
    // cannot know that the following <...> token is a header name.
    if (header.kind === 'symbol' && source[header.start] === '<' && source.startsWith('<stdio.h>', header.start)) return true;
  }
  return false;
}

/**
 * Conservatively detect stdio.h anywhere in a captured workspace. This can
 * enable the debug console for an unreferenced sibling, but never changes the
 * files prepared or executed by the engine.
 */
export function hasStdioIncludeInWorkspace(files: readonly { readonly source: string }[]): boolean {
  return files.some(file => hasDirectStdioInclude(file.source));
}
