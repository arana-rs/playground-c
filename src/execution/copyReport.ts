/** Copies from a user gesture, with a DOM fallback for insecure HTTP origins. */
export async function copyReportText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined') {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) return copyWithSelection(text);
      await clipboard.writeText(text);
      return true;
    } catch {
      // Some browsers expose Clipboard API but reject it on insecure origins.
    }
  }

  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;

  const textarea = document.createElement('textarea');
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;font-size:16px;';

  try {
    document.body.append(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
    try {
      if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
    } catch {
      // Focus restoration must not turn a successful copy into a reported failure.
    }
  }
}
