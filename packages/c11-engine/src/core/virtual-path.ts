/** Normalize a project path without consulting the host filesystem. */
export function normalizeVirtualPath(path: string, relativeTo = ''): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return undefined;
  const parts = relativeTo ? relativeTo.split('/').filter(Boolean) : [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : undefined;
}

export function virtualDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function virtualBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}
