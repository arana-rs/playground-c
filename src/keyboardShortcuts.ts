export type PlaygroundShortcut = 'toggle-run' | 'toggle-console';

type ShortcutKeyboardEvent = Pick<KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  | 'repeat' | 'isComposing' | 'keyCode' | 'defaultPrevented'>;

export function isMacPlatform(platform = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/u.test(platform);
}

/** Return only the global playground shortcuts, leaving other chords to the focused control. */
export function getPlaygroundShortcut(
  event: ShortcutKeyboardEvent,
  macOS = isMacPlatform(),
): PlaygroundShortcut | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey) {
    return null;
  }

  const runModifier = macOS
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (event.key === 'Enter' && runModifier && !event.shiftKey) return 'toggle-run';

  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && (event.key === '`' || event.code === 'Backquote')) {
    return 'toggle-console';
  }

  return null;
}
