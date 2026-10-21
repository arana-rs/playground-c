import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createDefaultWorkspace,
  createWorkspacePersister,
  getActiveWorkspaceFile,
  readWorkspace,
  updateWorkspaceFileSource,
} from '../src/editor/sourcePersistence.ts';
import { createServer } from 'vite';

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test('language preference falls back to English, persists valid choices, and leaves editor source intact', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { LANGUAGE_STORAGE_KEY, isLanguage, readLanguage, writeLanguage } = await vite.ssrLoadModule('/src/i18n.tsx');
    const storage = createStorage();

    assert.equal(LANGUAGE_STORAGE_KEY, 'c-playground-language');
    assert.equal(isLanguage('en'), true);
    assert.equal(isLanguage('es'), true);
    assert.equal(isLanguage('fr'), false);
    assert.equal(readLanguage(storage), 'en');

    assert.equal(writeLanguage(storage, 'es'), true);
    assert.equal(readLanguage(storage), 'es');
    storage.setItem(LANGUAGE_STORAGE_KEY, 'invalid');
    assert.equal(readLanguage(storage), 'en');
    assert.equal(readLanguage(storage, 'es'), 'es');
    assert.equal(readLanguage({ getItem() { throw new Error('storage unavailable'); } }), 'en');
    assert.equal(writeLanguage({ setItem() { throw new Error('storage unavailable'); } }, 'en'), false);

    const initialSource = 'int main(void) { return 0; }';
    const editedSource = 'int main(void) { return 42; }';
    const initialWorkspace = createDefaultWorkspace(initialSource);
    const persistWorkspace = createWorkspacePersister(initialWorkspace, () => storage);
    const editedWorkspace = updateWorkspaceFileSource(initialWorkspace, 'main', editedSource);
    persistWorkspace(editedWorkspace);
    assert.equal(writeLanguage(storage, 'en'), true);
    assert.equal(getActiveWorkspaceFile(readWorkspace(() => storage, initialSource)).source, editedSource);
    assert.equal(storage.values.get(LANGUAGE_STORAGE_KEY), 'en');
  } finally {
    await vite.close();
  }
});

test('language switch renders the current locale with an accessible next-language label', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const { LanguageSwitch } = await vite.ssrLoadModule('/src/components/LanguageSwitch.tsx');
    const renderSwitch = language => renderToStaticMarkup(createElement(
      LanguageProvider,
      { initialLanguage: language },
      createElement(LanguageSwitch),
    ));

    const englishMarkup = renderSwitch('en');
    assert.match(englishMarkup, /<button[^>]*aria-label="Switch language to Spanish"/u);
    assert.match(englishMarkup, /title="Switch language to Spanish"/u);
    assert.match(englishMarkup, /aria-pressed="false"/u);
    assert.match(englishMarkup, />ENG<\/span>/u);

    const spanishMarkup = renderSwitch('es');
    assert.match(spanishMarkup, /<button[^>]*aria-label="Cambiar idioma a inglés"/u);
    assert.match(spanishMarkup, /title="Cambiar idioma a inglés"/u);
    assert.match(spanishMarkup, /aria-pressed="true"/u);
    assert.match(spanishMarkup, />SPA<\/span>/u);
  } finally {
    await vite.close();
  }
});

test('unsupported workspace notice is localized and the editor and workspace controls render read-only', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { LanguageProvider } = await vite.ssrLoadModule('/src/i18n.tsx');
    const { WorkspacePersistenceNotice } = await vite.ssrLoadModule('/src/application/PlaygroundShell.tsx');
    const { WorkspaceFileTabs } = await vite.ssrLoadModule('/src/components/WorkspaceFileTabs.tsx');
    const { CodeEditor } = await vite.ssrLoadModule('/src/editor/CodeEditor.tsx');
    const renderLocalized = (element, language) => renderToStaticMarkup(createElement(
      LanguageProvider,
      { initialLanguage: language },
      element,
    ));

    const englishNotice = renderLocalized(createElement(WorkspacePersistenceNotice), 'en');
    const spanishNotice = renderLocalized(createElement(WorkspacePersistenceNotice), 'es');
    assert.match(englishNotice, /role="status"[^>]*aria-live="polite"/u);
    assert.match(englishNotice, /unsupported format/u);
    assert.doesNotMatch(englishNotice, /<button/u);
    assert.match(spanishNotice, /formato no compatible/u);

    const files = [{ id: 'main', name: 'main.c', source: 'int main(void) {}' }];
    const tabs = renderLocalized(createElement(WorkspaceFileTabs, {
      files,
      activeFileId: 'main',
      requestedFileId: 'main',
      isComposing: false,
      persistenceLocked: true,
      onSelectFile() {},
      onCreateFile() { return null; },
      onRenameFile() {},
      onDeleteFile() {},
    }), 'en');
    assert.match(tabs, /class="workspace-file-tab[^"]*"[^>]*disabled=""/u);
    assert.match(tabs, /class="workspace-file-tab__create"[^>]*disabled=""/u);

    const editor = renderLocalized(createElement(CodeEditor, {
      editorRef: { current: null },
      text: files[0].source,
      initialText: files[0].source,
      fileName: files[0].name,
      readOnly: true,
    }), 'en');
    assert.match(editor, /<textarea[^>]*readOnly=""/u);
  } finally {
    await vite.close();
  }
});

test('localized console chrome keeps program output and C diagnostics unchanged', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { LanguageProvider, useI18n } = await vite.ssrLoadModule('/src/i18n.tsx');
    const { ConsolePanel } = await vite.ssrLoadModule('/src/components/ConsolePanel.tsx');
    const output = 'program output: café\n';
    const diagnostic = 'main.c:3:5: Integer division or remainder by zero: undefined behavior in C11.';

    function LocalizedConsole() {
      const { t } = useI18n();
      return createElement(ConsolePanel, {
        statusLabel: t('console.status.ready'),
        statusTone: 'ready',
        segments: [
          { tone: 'program', text: output },
          { tone: 'error', text: diagnostic },
        ],
        inputRequestId: null,
        onSendStdinLine: () => false,
        onSendStdinEOF: () => false,
      });
    }

    const renderConsole = language => renderToStaticMarkup(createElement(
      LanguageProvider,
      { initialLanguage: language },
      createElement(LocalizedConsole),
    ));
    const englishMarkup = renderConsole('en');
    const spanishMarkup = renderConsole('es');

    assert.match(englishMarkup, /aria-label="Console"/u);
    assert.match(spanishMarkup, /aria-label="Consola"/u);
    for (const markup of [englishMarkup, spanishMarkup]) {
      assert.ok(markup.includes(output));
      assert.ok(markup.includes(diagnostic));
    }
  } finally {
    await vite.close();
  }
});
