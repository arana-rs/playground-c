export interface EditorCaretGeometry {
  readonly left: number;
  readonly top: number;
  readonly lineHeight: number;
}

/** Measure a textarea caret using the editor's font, tab stops, padding, and line height. */
export function getEditorCaretGeometry(
  editor: HTMLTextAreaElement,
  text: string,
  offset: number,
  measure: CanvasRenderingContext2D | null,
): EditorCaretGeometry {
  const style = getComputedStyle(editor);
  const fontSize = parseFloat(style.fontSize) || 13.5;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lineIndex = (before.match(/\n/gu) ?? []).length;
  const linePrefix = before.slice(before.lastIndexOf('\n') + 1);

  if (measure) measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const spaceWidth = measure?.measureText(' ').width || fontSize * 0.6;
  const tabWidth = style.tabSize.endsWith('px')
    ? parseFloat(style.tabSize) : (parseFloat(style.tabSize) || 4) * spaceWidth;
  const letterSpacing = parseFloat(style.letterSpacing) || 0;
  let textWidth = 0;
  linePrefix.split('\t').forEach((part, index) => {
    if (index > 0) textWidth = (Math.floor(textWidth / tabWidth) + 1) * tabWidth;
    textWidth += (measure?.measureText(part).width ?? part.length * spaceWidth)
      + Array.from(part).length * letterSpacing;
  });

  return {
    left: paddingLeft + textWidth,
    top: paddingTop + lineIndex * lineHeight,
    lineHeight,
  };
}
