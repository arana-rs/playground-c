export const PLAYGROUND_ROW_HEIGHTS = {
  header: 36,
  tabs: 28,
  footer: 24,
  separator: 8,
  minEditor: 120,
} as const;

export const CONSOLE_HEIGHT = {
  min: 48,
  defaultPanelRatio: 1 / 3,
  maxViewportRatio: 0.55,
  keyboardEditorMinimum: 48,
  keyboardPriorityRatio: 0.68,
  keyboardMaxViewportRatio: 0.72,
} as const;

export const VIEWPORT_LAYOUT = {
  keyboardMinimumReduction: 112,
  keyboardReductionRatio: 0.22,
  compactKeyboardHeight: 192,
  widthChangeTolerance: 0.12,
  scaleTolerance: 0.02,
} as const;

export interface ConsoleHeightBounds {
  min: number;
  max: number;
}

export interface VisibleViewportRect {
  width: number;
  height: number;
  left: number;
  top: number;
  scale: number;
}

export interface ViewportMeasurement {
  width: number;
  height: number;
  offsetLeft?: number;
  offsetTop?: number;
  scale?: number;
}

export interface KeyboardViewportSample {
  height: number;
  referenceHeight: number;
  width: number;
  referenceWidth: number;
  scale: number;
  stdinFocused: boolean;
}

export interface PlaygroundRows {
  header: number;
  tabs: number;
  editorMinimum: number;
  separator: number;
  footer: number;
  compactKeyboard: boolean;
}

export function getVisibleViewportRect(
  layoutWidth: number,
  layoutHeight: number,
  visualViewport?: ViewportMeasurement,
): VisibleViewportRect {
  const width = visualViewport?.width;
  const height = visualViewport?.height;
  const left = visualViewport?.offsetLeft;
  const top = visualViewport?.offsetTop;
  const scale = visualViewport?.scale;

  return {
    width: Number.isFinite(width) && width! > 0 ? width! : layoutWidth,
    height: Number.isFinite(height) && height! > 0 ? height! : layoutHeight,
    left: Number.isFinite(left) ? left! : 0,
    top: Number.isFinite(top) ? top! : 0,
    scale: Number.isFinite(scale) && scale! > 0 ? scale! : 1,
  };
}

function isUnzoomed(scale: number): boolean {
  return Math.abs(scale - 1) <= VIEWPORT_LAYOUT.scaleTolerance;
}

function getKeyboardViewportThreshold(referenceHeight: number): number {
  return Math.max(
    VIEWPORT_LAYOUT.keyboardMinimumReduction,
    Math.round(referenceHeight * VIEWPORT_LAYOUT.keyboardReductionRatio),
  );
}

export function isKeyboardViewportShrunk(sample: KeyboardViewportSample): boolean {
  if (!sample.stdinFocused || !isUnzoomed(sample.scale)) return false;
  if (sample.referenceWidth <= 0 || sample.width <= 0) return false;

  const widthChange = Math.abs(sample.width - sample.referenceWidth) / sample.referenceWidth;
  if (widthChange > VIEWPORT_LAYOUT.widthChangeTolerance) return false;

  return sample.referenceHeight - sample.height >= getKeyboardViewportThreshold(sample.referenceHeight);
}

export function hasKeyboardViewportRecovered(sample: KeyboardViewportSample): boolean {
  if (!isUnzoomed(sample.scale)) return false;
  if (sample.referenceWidth <= 0 || sample.width <= 0) return false;

  const widthChange = Math.abs(sample.width - sample.referenceWidth) / sample.referenceWidth;
  if (widthChange > VIEWPORT_LAYOUT.widthChangeTolerance) return true;

  return sample.height >= sample.referenceHeight - getKeyboardViewportThreshold(sample.referenceHeight);
}

export function getPlaygroundRows(
  viewportHeight: number,
  keyboardPriority = false,
  consoleVisible = true,
): PlaygroundRows {
  const compactKeyboard = keyboardPriority
    && consoleVisible
    && viewportHeight < VIEWPORT_LAYOUT.compactKeyboardHeight;
  return {
    header: compactKeyboard ? 0 : PLAYGROUND_ROW_HEIGHTS.header,
    tabs: PLAYGROUND_ROW_HEIGHTS.tabs,
    editorMinimum: compactKeyboard ? 0 : getEditorMinimumHeight(keyboardPriority),
    separator: consoleVisible && !compactKeyboard ? PLAYGROUND_ROW_HEIGHTS.separator : 0,
    footer: compactKeyboard ? 0 : PLAYGROUND_ROW_HEIGHTS.footer,
    compactKeyboard,
  };
}

function getAvailableEditorConsoleHeight(
  viewportHeight: number,
  keyboardPriority = false,
  consoleVisible = true,
): number {
  const rows = getPlaygroundRows(viewportHeight, keyboardPriority, consoleVisible);
  const fixedHeight = rows.header + rows.tabs + rows.footer + rows.separator;
  return Math.max(0, viewportHeight - fixedHeight);
}

export function getEditorMinimumHeight(keyboardPriority = false): number {
  return keyboardPriority ? CONSOLE_HEIGHT.keyboardEditorMinimum : PLAYGROUND_ROW_HEIGHTS.minEditor;
}

export function getConsoleHeightBounds(
  viewportHeight: number,
  keyboardPriority = false,
  consoleVisible = true,
): ConsoleHeightBounds {
  const rows = getPlaygroundRows(viewportHeight, keyboardPriority, consoleVisible);
  const availableHeight = getAvailableEditorConsoleHeight(viewportHeight, keyboardPriority, consoleVisible);
  if (rows.compactKeyboard) {
    return { min: Math.min(CONSOLE_HEIGHT.min, availableHeight), max: availableHeight };
  }

  const minEditor = rows.editorMinimum;
  const maxViewportRatio = keyboardPriority
    ? CONSOLE_HEIGHT.keyboardMaxViewportRatio
    : CONSOLE_HEIGHT.maxViewportRatio;
  const maxPreservingEditor = availableHeight - minEditor;
  const max = Math.max(
    CONSOLE_HEIGHT.min,
    Math.min(Math.round(viewportHeight * maxViewportRatio), maxPreservingEditor),
  );
  return { min: CONSOLE_HEIGHT.min, max };
}

export function clampConsoleHeight(height: number, bounds: ConsoleHeightBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(height)));
}

export function getInitialConsoleHeight(viewportHeight: number): number {
  const bounds = getConsoleHeightBounds(viewportHeight);
  const defaultHeight = getAvailableEditorConsoleHeight(viewportHeight) * CONSOLE_HEIGHT.defaultPanelRatio;
  return clampConsoleHeight(defaultHeight, bounds);
}

export function getEffectiveConsoleHeight(
  preferredHeight: number,
  viewportHeight: number,
  keyboardPriority: boolean,
  manuallyAdjustedDuringPriority = false,
  consoleVisible = true,
): number {
  const bounds = getConsoleHeightBounds(viewportHeight, keyboardPriority, consoleVisible);
  if (keyboardPriority && getPlaygroundRows(viewportHeight, true, consoleVisible).compactKeyboard) {
    return bounds.max;
  }
  if (!keyboardPriority || manuallyAdjustedDuringPriority) {
    return clampConsoleHeight(preferredHeight, bounds);
  }

  const keyboardPriorityHeight = Math.round(viewportHeight * CONSOLE_HEIGHT.keyboardPriorityRatio);
  return clampConsoleHeight(Math.max(preferredHeight, keyboardPriorityHeight), bounds);
}
