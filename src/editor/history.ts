import type { EditorSnapshot } from './types.ts';

type HistoryKind = 'typing' | 'delete' | 'action';

export interface HistoryOptions {
  kind?: HistoryKind;
  timestamp?: number;
}

interface HistoryEntry {
  before: EditorSnapshot;
  after: EditorSnapshot;
  kind: HistoryKind;
  timestamp: number;
}

function copy(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    text: snapshot.text,
    selection: { ...snapshot.selection },
    pairs: snapshot.pairs.map((pair) => ({ ...pair })),
  };
}

function equal(a: EditorSnapshot, b: EditorSnapshot): boolean {
  return a.text === b.text
    && a.selection.start === b.selection.start
    && a.selection.end === b.selection.end
    && a.selection.direction === b.selection.direction
    && JSON.stringify(a.pairs) === JSON.stringify(b.pairs);
}

/** One history owns both browser edits and editor commands. */
export function createEditorHistory(initial: EditorSnapshot) {
  const undoEntries: HistoryEntry[] = [];
  const redoEntries: HistoryEntry[] = [];
  let latest = copy(initial);
  let groupOpen = false;

  function breakGroup() {
    groupOpen = false;
  }

  function record(before: EditorSnapshot, after: EditorSnapshot, options: HistoryOptions = {}) {
    if (before.text === after.text) {
      latest = copy(after);
      breakGroup();
      return;
    }

    const kind = options.kind ?? 'action';
    const timestamp = options.timestamp ?? Date.now();
    const previous = undoEntries.at(-1);
    const canGroup = groupOpen
      && kind !== 'action'
      && previous?.kind === kind
      && timestamp >= previous.timestamp
      && timestamp - previous.timestamp < 750
      && before.selection.start === before.selection.end
      && after.selection.start === after.selection.end
      && equal(latest, before)
      && equal(previous.after, before);

    if (canGroup && previous) {
      previous.after = copy(after);
      previous.timestamp = timestamp;
    } else {
      undoEntries.push({ before: copy(before), after: copy(after), kind, timestamp });
    }

    latest = copy(after);
    redoEntries.length = 0;
    groupOpen = kind !== 'action';
  }

  function undo(current: EditorSnapshot): EditorSnapshot | null {
    breakGroup();
    const entry = undoEntries.pop();
    if (!entry) return null;

    redoEntries.push({ ...entry, after: copy(current) });
    latest = copy(entry.before);
    return copy(latest);
  }

  function redo(current: EditorSnapshot): EditorSnapshot | null {
    breakGroup();
    const entry = redoEntries.pop();
    if (!entry) return null;

    undoEntries.push({ ...entry, before: copy(current) });
    latest = copy(entry.after);
    return copy(latest);
  }

  return {
    record,
    breakGroup,
    undo,
    redo,
    canUndo: () => undoEntries.length > 0,
    canRedo: () => redoEntries.length > 0,
  };
}
