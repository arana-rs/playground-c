import type { ConsoleOutputSegment } from '../execution/useRunner.ts';

const MAX_CSI_COORDINATE = 1_000;
const MAX_CSI_PARAMETER_CHARS = 32;
const TAB_WIDTH = 8;

type TerminalRole = 'output' | 'input' | 'protected';

interface TerminalSegment extends ConsoleOutputSegment {
  readonly role?: TerminalRole;
  readonly stream?: 'stdout' | 'stderr' | 'stdin' | 'system';
}

interface TerminalCell {
  readonly text: string;
  readonly tone: ConsoleOutputSegment['tone'];
  readonly stream: TerminalSegment['stream'];
}

interface TerminalSegmentSnapshot {
  readonly tone: ConsoleOutputSegment['tone'];
  readonly text: string;
  readonly role: TerminalRole;
  readonly stream: TerminalSegment['stream'];
  readonly copyable?: boolean;
  readonly diagnosticLocations?: ConsoleOutputSegment['diagnosticLocations'];
}

export interface TerminalPresentationSnapshot {
  readonly screen: readonly ConsoleOutputSegment[];
  readonly protectedSegments: readonly ConsoleOutputSegment[];
}

function roleOf(segment: TerminalSegment): TerminalRole {
  return segment.role ?? (segment.stream === 'system' ? 'protected' : segment.stream === 'stdin' ? 'input' : 'output');
}

function snapshotSegment(segment: TerminalSegment): TerminalSegmentSnapshot {
  return {
    tone: segment.tone,
    text: segment.text,
    role: roleOf(segment),
    stream: segment.stream,
    ...(segment.copyable === false ? { copyable: false } : {}),
    ...(segment.diagnosticLocations?.length
      ? { diagnosticLocations: segment.diagnosticLocations.map(location => ({ ...location })) }
      : {}),
  };
}

function sameDiagnosticLocations(
  left: ConsoleOutputSegment['diagnosticLocations'],
  right: ConsoleOutputSegment['diagnosticLocations'],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((location, index) => {
    const other = right[index];
    return other !== undefined
      && location.start === other.start
      && location.end === other.end
      && location.file === other.file
      && location.line === other.line
      && location.column === other.column
      && location.sourceId === other.sourceId;
  });
}

function sameSegmentMetadata(left: TerminalSegmentSnapshot, right: TerminalSegmentSnapshot): boolean {
  return left.tone === right.tone
    && left.role === right.role
    && left.stream === right.stream
    && left.copyable === right.copyable
    && sameDiagnosticLocations(left.diagnosticLocations, right.diagnosticLocations);
}

function appendText(
  segments: ConsoleOutputSegment[],
  text: string,
  tone: ConsoleOutputSegment['tone'],
  stream?: TerminalSegment['stream'],
): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.tone === tone && previous.stream === stream) previous.text += text;
  else segments.push({ tone, text, role: 'output', stream });
}

function boundedParameter(text: string | undefined, fallback: number): number {
  if (!text) return fallback;
  try {
    const value = BigInt(text);
    if (value <= 0n) return fallback;
    return Number(value > BigInt(MAX_CSI_COORDINATE) ? BigInt(MAX_CSI_COORDINATE) : value);
  } catch {
    return fallback;
  }
}

/**
 * Projects the console's ordered transcript into a small text-mode terminal surface.
 * It deliberately implements only CR, BS, LF, tabs, and CSI K/J/H/f.
 */
export class TerminalPresentation {
  private rows = new Map<number, Map<number, TerminalCell>>();
  private lineFeeds = new Set<number>();
  private cursorRow = 0;
  private cursorColumn = 0;
  private lastRow = 0;
  private parserState: 'text' | 'escape' | 'escape-intermediate' | 'csi' = 'text';
  private csiParameters = '';
  private discardCsiParameters = false;
  private previousSegments: TerminalSegmentSnapshot[] = [];
  private previousResetKey: string | number | undefined;
  private protectedSegments: ConsoleOutputSegment[] = [];

  update(
    segments: readonly TerminalSegment[],
    resetKey?: string | number,
  ): TerminalPresentationSnapshot {
    const incoming = segments.map(snapshotSegment);
    const reset = this.previousResetKey !== resetKey || !this.canContinue(incoming);
    let startIndex = 0;
    let continuation = '';

    if (reset) {
      this.resetScreen();
    } else {
      startIndex = this.previousSegments.length;
      const previousLength = this.previousSegments.length;
      if (previousLength > 0 && incoming.length >= previousLength) {
        const previousTail = this.previousSegments[previousLength - 1];
        const currentTail = incoming[previousLength - 1];
        if (currentTail.text.length > previousTail.text.length) {
          continuation = currentTail.text.slice(previousTail.text.length);
          startIndex = previousLength - 1;
        }
      }
    }

    if (reset) {
      startIndex = 0;
    }

    for (let index = startIndex; index < incoming.length; index += 1) {
      const segment = incoming[index];
      if (!segment) continue;
      const text = index === startIndex && continuation ? continuation : segment.text;
      this.appendSegment(segment, text);
    }

    this.previousSegments = incoming;
    this.previousResetKey = resetKey;
    return this.snapshot();
  }

  private canContinue(incoming: readonly TerminalSegmentSnapshot[]): boolean {
    if (incoming.length < this.previousSegments.length) return false;
    for (let index = 0; index < this.previousSegments.length; index += 1) {
      const previous = this.previousSegments[index];
      const current = incoming[index];
      if (!previous || !current || !sameSegmentMetadata(previous, current)) return false;
      if (index === this.previousSegments.length - 1) {
        if (!current.text.startsWith(previous.text)) return false;
      } else if (previous.text !== current.text) {
        return false;
      }
    }
    return true;
  }

  private appendSegment(segment: TerminalSegmentSnapshot, text: string): void {
    if (segment.role === 'protected') {
      if (text) {
        const previous = this.protectedSegments.at(-1);
        const diagnosticLocations = segment.diagnosticLocations?.length ? segment.diagnosticLocations : undefined;
        if (!diagnosticLocations && !previous?.diagnosticLocations?.length
          && previous?.tone === segment.tone && previous.copyable === segment.copyable && previous.stream === segment.stream) previous.text += text;
        else this.protectedSegments.push({
          tone: segment.tone,
          text,
          role: 'protected',
          stream: segment.stream,
          ...(segment.copyable === false ? { copyable: false } : {}),
          ...(diagnosticLocations ? { diagnosticLocations } : {}),
        });
      }
      return;
    }
    if (segment.role === 'input') {
      this.appendLiteral(text, segment.tone, segment.stream);
      return;
    }
    this.appendOutput(text, segment.tone, segment.stream);
  }

  private resetScreen(): void {
    this.rows = new Map();
    this.lineFeeds = new Set();
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.lastRow = 0;
    this.parserState = 'text';
    this.csiParameters = '';
    this.discardCsiParameters = false;
    this.protectedSegments = [];
  }

  private appendOutput(text: string, tone: ConsoleOutputSegment['tone'], stream: TerminalSegment['stream']): void {
    for (const character of text) {
      if (this.parserState === 'escape') {
        if (character === '[') {
          this.parserState = 'csi';
          this.csiParameters = '';
          this.discardCsiParameters = false;
        } else if (character === '\u001b') {
          this.parserState = 'escape';
        } else if (character >= '\u0030' && character <= '\u007e') {
          this.parserState = 'text';
        } else if (character >= '\u0020' && character <= '\u002f') {
          this.parserState = 'escape-intermediate';
        } else {
          this.parserState = 'text';
          this.appendTextCharacter(character, tone, stream);
        }
        continue;
      }

      if (this.parserState === 'escape-intermediate') {
        if (character === '\u001b') {
          this.parserState = 'escape';
        } else if (character >= '\u0030' && character <= '\u007e') {
          this.parserState = 'text';
        } else if (character < '\u0020' || character > '\u002f') {
          this.parserState = 'text';
          this.appendTextCharacter(character, tone, stream);
        }
        continue;
      }

      if (this.parserState === 'csi') {
        if (character === '\u001b') {
          this.parserState = 'escape';
          this.csiParameters = '';
          this.discardCsiParameters = false;
        } else if (character >= '\u0040' && character <= '\u007e') {
          if (!this.discardCsiParameters) this.applyCsi(this.csiParameters, character);
          this.parserState = 'text';
          this.csiParameters = '';
          this.discardCsiParameters = false;
        } else if (character >= '\u0020' && character <= '\u003f') {
          if (this.csiParameters.length < MAX_CSI_PARAMETER_CHARS) this.csiParameters += character;
          else this.discardCsiParameters = true;
        } else {
          this.parserState = 'text';
          this.csiParameters = '';
          this.discardCsiParameters = false;
          this.appendTextCharacter(character, tone, stream);
        }
        continue;
      }

      if (character === '\u001b') {
        this.parserState = 'escape';
        continue;
      }
      this.appendTextCharacter(character, tone, stream);
    }
  }

  private appendLiteral(text: string, tone: ConsoleOutputSegment['tone'], stream: TerminalSegment['stream']): void {
    for (const character of text) {
      if (character === '\n') this.advanceLine();
      else if (character === '\t') this.appendTab(tone, stream);
      else this.writeCell(character, tone, stream);
    }
  }

  private appendTextCharacter(character: string, tone: ConsoleOutputSegment['tone'], stream: TerminalSegment['stream']): void {
    if (character === '\r') {
      this.cursorColumn = 0;
      return;
    }
    if (character === '\b') {
      this.cursorColumn = Math.max(0, this.cursorColumn - 1);
      return;
    }
    if (character === '\n') {
      this.advanceLine();
      return;
    }
    if (character === '\t') {
      this.appendTab(tone, stream);
      return;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return;
    this.writeCell(character, tone, stream);
  }

  private advanceLine(): void {
    this.lineFeeds.add(this.cursorRow);
    this.cursorRow += 1;
    this.cursorColumn = 0;
    this.lastRow = Math.max(this.lastRow, this.cursorRow);
  }

  private appendTab(tone: ConsoleOutputSegment['tone'], stream: TerminalSegment['stream']): void {
    const nextStop = (Math.floor(this.cursorColumn / TAB_WIDTH) + 1) * TAB_WIDTH;
    while (this.cursorColumn < nextStop) this.writeCell(' ', tone, stream);
  }

  private writeCell(text: string, tone: ConsoleOutputSegment['tone'], stream: TerminalSegment['stream']): void {
    let row = this.rows.get(this.cursorRow);
    if (!row) {
      row = new Map();
      this.rows.set(this.cursorRow, row);
    }
    row.set(this.cursorColumn, { text, tone, stream });
    this.lastRow = Math.max(this.lastRow, this.cursorRow);
    this.cursorColumn += 1;
  }

  private applyCsi(parameters: string, final: string): void {
    if (!/^\d*(?:;\d*)*$/u.test(parameters)) return;
    const values = parameters === '' ? [] : parameters.split(';');
    if (final === 'K') {
      const mode = boundedParameter(values[0], 0);
      this.eraseLine(mode);
    } else if (final === 'J') {
      const mode = boundedParameter(values[0], 0);
      this.eraseDisplay(mode);
    } else if (final === 'H' || final === 'f') {
      this.cursorRow = boundedParameter(values[0], 1) - 1;
      this.cursorColumn = boundedParameter(values[1], 1) - 1;
    }
  }

  private eraseLine(mode: number): void {
    const row = this.rows.get(this.cursorRow);
    if (!row) return;
    if (mode === 0) {
      for (const column of row.keys()) if (column >= this.cursorColumn) row.delete(column);
    } else if (mode === 1) {
      for (const column of row.keys()) if (column <= this.cursorColumn) row.delete(column);
    } else if (mode === 2) {
      row.clear();
    }
    if (row.size === 0) this.rows.delete(this.cursorRow);
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2) {
      this.rows.clear();
      this.lineFeeds.clear();
      this.lastRow = 0;
      return;
    }
    if (mode === 0) {
      const current = this.rows.get(this.cursorRow);
      if (current) {
        for (const column of current.keys()) if (column >= this.cursorColumn) current.delete(column);
        if (current.size === 0) this.rows.delete(this.cursorRow);
      }
      for (const row of this.rows.keys()) if (row > this.cursorRow) this.rows.delete(row);
      for (const row of this.lineFeeds) if (row > this.cursorRow) this.lineFeeds.delete(row);
      this.lastRow = Math.min(this.lastRow, this.cursorRow);
      return;
    }
    if (mode === 1) {
      for (const [rowIndex, row] of this.rows) {
        if (rowIndex < this.cursorRow) this.rows.delete(rowIndex);
        else if (rowIndex === this.cursorRow) {
          for (const column of row.keys()) if (column <= this.cursorColumn) row.delete(column);
          if (row.size === 0) this.rows.delete(rowIndex);
        }
      }
      for (const row of this.lineFeeds) if (row < this.cursorRow) this.lineFeeds.delete(row);
    }
  }

  private snapshot(): TerminalPresentationSnapshot {
    const screen: ConsoleOutputSegment[] = [];
    for (let rowIndex = 0; rowIndex <= this.lastRow; rowIndex += 1) {
      const row = this.rows.get(rowIndex);
      let lastColumn = -1;
      if (row) for (const column of row.keys()) lastColumn = Math.max(lastColumn, column);
      for (let column = 0; column <= lastColumn; column += 1) {
        const cell = row?.get(column);
        appendText(screen, cell?.text ?? ' ', cell?.tone ?? 'program', cell?.stream);
      }
      if (rowIndex < this.lastRow || this.lineFeeds.has(rowIndex)) {
        const lastCell = lastColumn >= 0 ? row?.get(lastColumn) : undefined;
        appendText(screen, '\n', lastCell?.tone ?? 'program', lastCell?.stream);
      }
    }
    return {
      screen,
      protectedSegments: this.protectedSegments.map(segment => ({ ...segment })),
    };
  }
}

export function getConsoleCopyText(presentation: TerminalPresentationSnapshot): string {
  return [...presentation.screen, ...presentation.protectedSegments]
    .filter(segment => segment.copyable !== false)
    .map(segment => segment.text)
    .join('');
}
