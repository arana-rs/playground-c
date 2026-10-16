import { getCContext } from './context.ts';
import { isEditorTextWithinLineLimit, normalizeEditorText } from './limits.ts';
import type { AutoPair, EditorCommand, EditorSelection, EditorSnapshot } from './types.ts';

const INDENT = '    ';
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

interface TextEdit {
  start: number;
  end: number;
  inserted: string;
}

function caret(position: number): EditorSelection {
  return { start: position, end: position, direction: 'none' };
}

function normalizePosition(text: string, position: number): number {
  const bounded = Math.max(0, Math.min(position, text.length));
  return normalizeEditorText(text.slice(0, bounded)).length;
}

function normalizeSelection(text: string, selection: EditorSelection): EditorSelection {
  return {
    start: normalizePosition(text, selection.start),
    end: normalizePosition(text, selection.end),
    direction: selection.direction,
  };
}

function normalizeSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  const text = normalizeEditorText(snapshot.text);
  return {
    text,
    selection: normalizeSelection(snapshot.text, snapshot.selection),
    pairs: snapshot.pairs.map((pair) => ({
      ...pair,
      open: normalizePosition(snapshot.text, pair.open),
      close: normalizePosition(snapshot.text, pair.close),
    })),
  };
}

function lineStartAt(text: string, position: number): number {
  return position === 0 ? 0 : text.lastIndexOf('\n', position - 1) + 1;
}

function mapOffset(position: number, edit: TextEdit, affinity: 'left' | 'right'): number {
  if (position < edit.start) return position;
  if (position > edit.end) return position + edit.inserted.length - (edit.end - edit.start);
  if (position === edit.start && affinity === 'left') return edit.start;
  return edit.start + edit.inserted.length;
}

function movePairs(pairs: AutoPair[], text: string, edit: TextEdit): AutoPair[] {
  const delta = edit.inserted.length - (edit.end - edit.start);
  const touched = (position: number) => position >= edit.start && position < edit.end;
  const move = (position: number) => position >= edit.end ? position + delta : position;

  return pairs.flatMap((pair) => {
    if (touched(pair.open) || touched(pair.close)) return [];
    const moved = { ...pair, open: move(pair.open), close: move(pair.close) };
    return moved.open < moved.close
      && text[moved.open] === moved.opener
      && text[moved.close] === moved.closer
      ? [moved]
      : [];
  });
}

function editSnapshot(snapshot: EditorSnapshot, edit: TextEdit, selection?: EditorSelection): EditorSnapshot {
  const text = snapshot.text.slice(0, edit.start) + edit.inserted + snapshot.text.slice(edit.end);
  return {
    text,
    selection: selection ?? {
      start: mapOffset(snapshot.selection.start, edit, 'left'),
      end: mapOffset(snapshot.selection.end, edit, 'right'),
      direction: snapshot.selection.direction,
    },
    pairs: movePairs(snapshot.pairs, text, edit),
  };
}

function canSkipPair(snapshot: EditorSnapshot, character: string): boolean {
  const { start, end } = snapshot.selection;
  if (start !== end || snapshot.text[start] !== character) return false;
  if (!snapshot.pairs.some((pair) => pair.close === start && pair.closer === character)) return false;
  const context = getCContext(snapshot.text, start);
  if (character === '"') return context.kind === 'string' && !context.escaped;
  if (character === "'") return context.kind === 'character' && !context.escaped;
  return context.kind === 'code';
}

function typeCharacter(snapshot: EditorSnapshot, character: string): EditorSnapshot | null {
  if (character.length !== 1) return null;
  if (canSkipPair(snapshot, character)) {
    return { ...snapshot, selection: caret(snapshot.selection.start + 1) };
  }

  const closer = CLOSERS[character];
  if (!closer) return null;
  const { start, end, direction } = snapshot.selection;
  const context = getCContext(snapshot.text, start);
  const quote = character === '"' || character === "'";
  if (context.kind !== 'code' || (quote && context.escaped)) return null;

  if (start === end) {
    const next = snapshot.text[start];
    // Only add a second character where it will not split an existing token.
    if (next && !/[\s)\]};,:]/u.test(next)) return null;
    if (quote) {
      const logicalPrefix = snapshot.text.slice(0, start).replace(/\\(?:\r\n|\n|\r)/g, '');
      const adjacentWord = logicalPrefix.match(/([\p{L}\p{N}_$]+)$/u)?.[0];
      if (adjacentWord && !['L', 'u8', 'u', 'U'].includes(adjacentWord)) return null;
    }
  }

  const selection = start === end
    ? caret(start + 1)
    : { start: start + 1, end: end + 1, direction };
  const result = start === end
    ? editSnapshot(snapshot, { start, end, inserted: character + closer }, selection)
    : editSnapshot(
      editSnapshot(snapshot, { start: end, end, inserted: closer }),
      { start, end: start, inserted: character }, selection,
    );
  result.pairs.push({ open: start, close: end + 1, opener: character, closer });
  return result;
}

function backspace(snapshot: EditorSnapshot): EditorSnapshot | null {
  const { start, end } = snapshot.selection;
  if (start !== end) return null;
  const pair = snapshot.pairs.find((candidate) => candidate.open === start - 1 && candidate.close === start);
  if (!pair || snapshot.text[pair.open] !== pair.opener || snapshot.text[pair.close] !== pair.closer) return null;
  return editSnapshot(snapshot, { start: start - 1, end: start + 1, inserted: '' }, caret(start - 1));
}

function enter(snapshot: EditorSnapshot): EditorSnapshot {
  const { text } = snapshot;
  const { start, end } = snapshot.selection;
  const lineStart = lineStartAt(text, start);
  const before = text.slice(lineStart, start);
  const indentation = before.match(/^[ \t]*/)?.[0] ?? '';
  const left = before.trimEnd();
  const rightWhitespace = text.slice(end).match(/^[ \t]*/)?.[0] ?? '';
  const close = end + rightWhitespace.length;
  const open = lineStart + left.length - 1;
  const afterOpeningBrace = left.endsWith('{')
    && getCContext(text, open).kind === 'code'
    && getCContext(text, start).kind === 'code';

  if (afterOpeningBrace && text[close] === '}') {
    const inserted = `\n${indentation}${INDENT}\n${indentation}`;
    const insertionStart = open + 1;
    return editSnapshot(snapshot, { start: insertionStart, end: close, inserted },
      caret(insertionStart + 1 + indentation.length + INDENT.length));
  }

  const inserted = `\n${indentation}${afterOpeningBrace ? INDENT : ''}`;
  return editSnapshot(snapshot, { start, end, inserted }, caret(start + inserted.length));
}

function selectedLineStarts(text: string, start: number, end: number): number[] {
  const starts = [lineStartAt(text, start)];
  let newline = text.indexOf('\n', starts[0]);
  while (newline >= 0 && newline + 1 < end) {
    starts.push(newline + 1);
    newline = text.indexOf('\n', newline + 1);
  }
  return starts;
}

function indent(snapshot: EditorSnapshot, outdent: boolean): EditorSnapshot {
  const { start, end } = snapshot.selection;
  if (start === end && !outdent) {
    return editSnapshot(snapshot, { start, end, inserted: INDENT }, caret(start + INDENT.length));
  }

  let result = snapshot;
  const starts = selectedLineStarts(snapshot.text, start, end);
  for (const lineStart of starts.reverse()) {
    let removed = 0;
    if (outdent) {
      removed = snapshot.text[lineStart] === '\t'
        ? 1
        : snapshot.text.slice(lineStart).match(/^ {1,4}/)?.[0].length ?? 0;
    }
    if (!outdent || removed > 0) {
      result = editSnapshot(result, { start: lineStart, end: lineStart + removed, inserted: outdent ? '' : INDENT });
    }
  }
  if (start === end) result = { ...result, selection: caret(result.selection.end) };
  return result;
}

function applyEditorCommandUnchecked(snapshot: EditorSnapshot, command: EditorCommand): EditorSnapshot | null {
  switch (command.type) {
    case 'type': return typeCharacter(snapshot, command.character);
    case 'backspace': return backspace(snapshot);
    case 'enter': return enter(snapshot);
    case 'indent': return indent(snapshot, command.outdent);
  }
}

export type EditorCommandEvaluation =
  | { status: 'applied'; snapshot: EditorSnapshot }
  | { status: 'unsupported' }
  | { status: 'line-limit'; snapshot: EditorSnapshot };

/** Calculate once and distinguish an ordinary native edit from a limit rejection. */
export function evaluateEditorCommand(
  snapshot: EditorSnapshot,
  command: EditorCommand,
): EditorCommandEvaluation {
  const result = applyEditorCommandUnchecked(normalizeSnapshot(snapshot), command);
  if (!result) return { status: 'unsupported' };
  const normalizedResult = normalizeSnapshot(result);
  return isEditorTextWithinLineLimit(normalizedResult.text)
    ? { status: 'applied', snapshot: normalizedResult }
    : { status: 'line-limit', snapshot: normalizedResult };
}

/** Compatibility helper; use evaluateEditorCommand to tell rejection from native fallback. */
export function applyEditorCommand(snapshot: EditorSnapshot, command: EditorCommand): EditorSnapshot | null {
  const evaluation = evaluateEditorCommand(snapshot, command);
  return evaluation.status === 'applied' ? evaluation.snapshot : null;
}

function describesChange(previous: string, next: string, edit: TextEdit): boolean {
  return previous.slice(0, edit.start) + edit.inserted + previous.slice(edit.end) === next;
}

function findNativeEdit(previous: EditorSnapshot, text: string, selection: EditorSelection): TextEdit {
  const { start, end } = previous.selection;
  const insertedLength = text.length - (previous.text.length - (end - start));
  if (insertedLength >= 0) {
    const atSelection = { start, end, inserted: text.slice(start, start + insertedLength) };
    if (describesChange(previous.text, text, atSelection)) return atSelection;
  }

  const removedLength = previous.text.length - text.length;
  if (start === end && selection.start === selection.end && removedLength > 0) {
    const removalStart = selection.start < start ? selection.start : start;
    const removal = { start: removalStart, end: removalStart + removedLength, inserted: '' };
    if (describesChange(previous.text, text, removal)) return removal;
  }

  let prefix = 0;
  while (prefix < previous.text.length && prefix < text.length && previous.text[prefix] === text[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.text.length - prefix && suffix < text.length - prefix
    && previous.text[previous.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix += 1;
  return { start: prefix, end: previous.text.length - suffix, inserted: text.slice(prefix, text.length - suffix) };
}

export function reconcileNativeEdit(previous: EditorSnapshot, text: string, selection: EditorSelection): EditorSnapshot {
  const before = normalizeSnapshot(previous);
  const normalizedText = normalizeEditorText(text);
  const normalizedSelection = normalizeSelection(text, selection);
  if (before.text === normalizedText) return { ...before, selection: normalizedSelection };
  const edit = findNativeEdit(before, normalizedText, normalizedSelection);
  return { text: normalizedText, selection: normalizedSelection, pairs: movePairs(before.pairs, normalizedText, edit) };
}

export type NativeEditEvaluation =
  | { status: 'applied'; snapshot: EditorSnapshot }
  | { status: 'line-limit'; snapshot: EditorSnapshot };

/** Normalize and validate a completed browser edit before it enters history. */
export function evaluateNativeEdit(
  previous: EditorSnapshot,
  text: string,
  selection: EditorSelection,
): NativeEditEvaluation {
  const snapshot = reconcileNativeEdit(previous, text, selection);
  return isEditorTextWithinLineLimit(snapshot.text)
    ? { status: 'applied', snapshot }
    : { status: 'line-limit', snapshot };
}

export function getCursorPosition(snapshot: EditorSnapshot): { line: number; column: number } {
  const normalized = normalizeSnapshot(snapshot);
  const position = normalized.selection.direction === 'backward' ? normalized.selection.start : normalized.selection.end;
  const before = normalized.text.slice(0, position);
  return { line: before.split('\n').length, column: position - before.lastIndexOf('\n') };
}
