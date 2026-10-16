export type SelectionDirection = 'forward' | 'backward' | 'none';

export interface EditorSelection {
  start: number;
  end: number;
  direction: SelectionDirection;
}

export interface AutoPair {
  open: number;
  close: number;
  opener: string;
  closer: string;
}

export interface EditorSnapshot {
  text: string;
  selection: EditorSelection;
  pairs: AutoPair[];
}

export type EditorCommand =
  | { type: 'type'; character: string }
  | { type: 'backspace' }
  | { type: 'enter' }
  | { type: 'indent'; outdent: boolean };
