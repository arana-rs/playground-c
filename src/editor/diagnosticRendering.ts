import type { HighlightKind, HighlightToken } from './highlight.ts';

export interface DiagnosticAnchorRange {
  readonly start: number;
  readonly length: number;
  readonly kind?: 'primary' | 'related';
  readonly diagnosticLine?: number;
}

export interface EditorHighlightSegment {
  readonly start: number;
  readonly end: number;
  readonly kind: HighlightKind;
  readonly diagnostic: boolean;
  readonly related?: boolean;
  readonly diagnosticLine?: number;
}

export interface DiagnosticAnchorHitbox {
  readonly line: number;
  readonly offset: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const DIAGNOSTIC_POPOVER_GAP = 8;

export interface DiagnosticPopoverVerticalPlacement {
  readonly side: 'above' | 'below';
  readonly top: number;
  readonly maxHeight: number;
}

interface DiagnosticAnchorRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Cover the marked character and the underline just below its rendered bounds. */
export function createDiagnosticAnchorHitbox(
  rect: DiagnosticAnchorRect,
  line: number,
  offset: number,
): DiagnosticAnchorHitbox {
  return {
    line,
    offset,
    left: rect.left - 1,
    right: rect.right + 1,
    top: rect.top,
    bottom: rect.bottom + 4,
  };
}

/** Find the closest marked source character beneath a pointer. */
export function findDiagnosticAnchorAtPoint(
  anchors: readonly DiagnosticAnchorHitbox[],
  x: number,
  y: number,
): DiagnosticAnchorHitbox | null {
  let match: DiagnosticAnchorHitbox | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    if (x < anchor.left || x > anchor.right || y < anchor.top || y > anchor.bottom) continue;
    const distance = Math.abs(x - (anchor.left + anchor.right) / 2);
    if (distance < closestDistance) {
      match = anchor;
      closestDistance = distance;
    }
  }
  return match;
}

/** Place a diagnostic popover wholly above or below its active source line. */
export function getDiagnosticPopoverVerticalPlacement(
  lineTop: number,
  lineHeight: number,
  viewportHeight: number,
  popoverHeight: number,
): DiagnosticPopoverVerticalPlacement {
  const inset = 4;
  const belowTop = lineTop + lineHeight + DIAGNOSTIC_POPOVER_GAP;
  const belowSpace = Math.max(0, viewportHeight - belowTop - inset);
  const aboveSpace = Math.max(0, lineTop - DIAGNOSTIC_POPOVER_GAP - inset);
  const side = belowSpace >= popoverHeight || belowSpace >= aboveSpace ? 'below' : 'above';
  const availableHeight = side === 'below' ? belowSpace : aboveSpace;
  const visibleHeight = Math.min(popoverHeight, availableHeight);
  const requestedTop = side === 'below'
    ? belowTop
    : lineTop - DIAGNOSTIC_POPOVER_GAP - visibleHeight;
  const maxTop = Math.max(inset, viewportHeight - visibleHeight - inset);

  return {
    side,
    top: Math.max(inset, Math.min(requestedTop, maxTop)),
    maxHeight: availableHeight,
  };
}

function isSurrogatePair(source: string, start: number): boolean {
  if (start < 0 || start + 1 >= source.length) return false;
  const high = source.charCodeAt(start);
  const low = source.charCodeAt(start + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function isCodePointBoundary(source: string, offset: number): boolean {
  return offset <= 0 || offset >= source.length || !isSurrogatePair(source, offset - 1);
}

interface DiagnosticMarkInterval {
  readonly start: number;
  readonly end: number;
  readonly related: boolean;
  readonly diagnosticLine?: number;
}

function buildDiagnosticMarkIntervals(
  source: string,
  ranges: readonly DiagnosticAnchorRange[],
): DiagnosticMarkInterval[] {
  const events = new Map<number, { starts: DiagnosticAnchorRange[]; ends: DiagnosticAnchorRange[] }>();
  const eventAt = (offset: number) => {
    let event = events.get(offset);
    if (!event) {
      event = { starts: [], ends: [] };
      events.set(offset, event);
    }
    return event;
  };
  for (const range of ranges) {
    const end = range.start + range.length;
    if (!Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.length)
      || range.start < 0
      || range.length <= 0
      || end > source.length
      || !isCodePointBoundary(source, range.start)
      || !isCodePointBoundary(source, end)) continue;
    eventAt(range.start).starts.push(range);
    eventAt(end).ends.push(range);
  }

  const activePrimaryLines = new Map<number, number>();
  const activeRelatedLines = new Map<number, number>();
  let unscopedPrimary = 0;
  let unscopedRelated = 0;
  const intervals: DiagnosticMarkInterval[] = [];
  const boundaries = [...events.keys()].sort((left, right) => left - right);
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index];
    const event = events.get(boundary)!;
    const updateActive = (range: DiagnosticAnchorRange, delta: 1 | -1) => {
      const related = range.kind === 'related';
      const lines = related ? activeRelatedLines : activePrimaryLines;
      if (range.diagnosticLine === undefined) {
        if (related) unscopedRelated += delta;
        else unscopedPrimary += delta;
        return;
      }
      const count = (lines.get(range.diagnosticLine) ?? 0) + delta;
      if (count <= 0) lines.delete(range.diagnosticLine);
      else lines.set(range.diagnosticLine, count);
    };
    for (const range of event.ends) updateActive(range, -1);
    for (const range of event.starts) updateActive(range, 1);

    const next = boundaries[index + 1];
    if (next === undefined || next <= boundary) continue;
    const hasPrimary = unscopedPrimary > 0 || activePrimaryLines.size > 0;
    const hasRelated = unscopedRelated > 0 || activeRelatedLines.size > 0;
    if (!hasPrimary && !hasRelated) continue;
    const related = !hasPrimary && hasRelated;
    const lineCounts = related ? activeRelatedLines : activePrimaryLines;
    const diagnosticLine = lineCounts.size > 0 ? Math.min(...lineCounts.keys()) : undefined;
    const previous = intervals.at(-1);
    if (previous && previous.end === boundary && previous.related === related
      && previous.diagnosticLine === diagnosticLine) {
      intervals[intervals.length - 1] = { ...previous, end: next };
    } else {
      intervals.push({ start: boundary, end: next, related, diagnosticLine });
    }
  }
  return intervals;
}

/** Split shared syntax spans around diagnostic anchors without changing source text. */
export function splitHighlightTokensAtDiagnostics(
  source: string,
  tokens: readonly HighlightToken[],
  anchors: readonly DiagnosticAnchorRange[],
): EditorHighlightSegment[] {
  const markIntervals = buildDiagnosticMarkIntervals(source, anchors);
  const segments: EditorHighlightSegment[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  let markIndex = 0;

  while (cursor < source.length) {
    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= cursor) tokenIndex++;
    while (markIndex < markIntervals.length && markIntervals[markIndex].end <= cursor) markIndex++;

    const token = tokens[tokenIndex];
    const activeToken = token && token.start <= cursor && cursor < token.end ? token : undefined;
    const mark = markIntervals[markIndex];
    const activeMark = mark && mark.start <= cursor && cursor < mark.end ? mark : undefined;
    const nextMarkStart = !activeMark && mark && mark.start > cursor ? mark.start : source.length;
    const nextTokenStart = !activeToken && token && token.start > cursor ? token.start : source.length;
    let end = Math.min(
      source.length,
      activeToken?.end ?? source.length,
      activeMark?.end ?? nextMarkStart,
      nextTokenStart,
    );
    if (end < source.length && isSurrogatePair(source, end - 1)) end++;
    if (end <= cursor) {
      // Ignore malformed or overlapping token spans while keeping the source intact.
      tokenIndex++;
      continue;
    }
    segments.push({
      start: cursor,
      end,
      kind: activeToken?.kind ?? 'plain',
      diagnostic: activeMark !== undefined,
      ...(activeMark?.related ? { related: true } : {}),
      ...(activeMark?.diagnosticLine !== undefined ? { diagnosticLine: activeMark.diagnosticLine } : {}),
    });
    cursor = end;
  }

  return segments;
}
