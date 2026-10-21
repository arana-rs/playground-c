export const MAKEFILE_NAME = 'Makefile';

export type EditorLanguage = 'c' | 'makefile';

export function getEditorLanguage(fileName: string): EditorLanguage {
  return fileName === MAKEFILE_NAME ? 'makefile' : 'c';
}
