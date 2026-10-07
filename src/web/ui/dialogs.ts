import type { Editor } from '../model/editor.js';
import type { EventTreeEditor } from '../model/event-tree-editor.js';
import { h } from './dom.js';

/** A model name is a plain file stem (the server enforces the same rule). */
export const NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const nameProblem = (name: string): string | null => {
  if (name === '') return 'Enter a name.';
  if (!NAME_RULE.test(name) || name.endsWith('.') || name.includes('..')) return 'Use letters, digits, dot, dash or underscore, starting with a letter or digit (up to 64 characters).';
  return null;
};

function modal(title: string, body: (close: (value: string | null) => void, dialog: HTMLDialogElement) => HTMLElement[]): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'dlg-title' }) as HTMLDialogElement;
    let result: string | null = null;
    const close = (value: string | null): void => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    const form = h('form', { method: 'dialog', onsubmit: (e) => e.preventDefault() }, h('h2', { id: 'dlg-title' }, title), ...body(close, dialog));
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Lists the saved models; resolves with the chosen name or null. */
export async function openDialog(editor: Editor): Promise<string | null> {
  await editor.refreshModels();
  return modal('Open a saved model', (close) => {
    const models = editor.models;
    return [
      models.length === 0
        ? h('p', { class: 'hint', 'data-testid': 'no-models' }, 'No saved models yet. Use Save to keep the current one.')
        : h('ul', { class: 'model-list', 'aria-label': 'Saved models' }, ...models.map((m) => h('li', {}, h('button', { type: 'button', 'data-model': m.name, onclick: () => close(m.name) }, h('span', {}, m.name), h('span', { class: 'meta' }, `${new Date(m.modified).toLocaleString()}`))))),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel')),
    ];
  });
}

/** Asks for a name to save under; resolves with a valid name or null. */
export async function saveAsDialog(editor: Editor, suggested: string): Promise<string | null> {
  await editor.refreshModels();
  return modal('Save as', (close) => {
    const err = h('span', { class: 'field-error', id: 'save-err', role: 'alert', hidden: true });
    const input = h('input', { type: 'text', id: 'save-name', value: suggested, maxlength: 64, 'aria-describedby': 'save-err', 'data-field': 'save-name' }) as HTMLInputElement;
    const ok = h('button', { class: 'btn primary', type: 'button', 'data-testid': 'save-confirm' }, 'Save') as HTMLButtonElement;
    const refresh = (): void => {
      const p = nameProblem(input.value.trim());
      err.hidden = p === null || input.value === '';
      err.textContent = p ?? '';
      input.toggleAttribute('aria-invalid', p !== null && input.value !== '');
      const exists = editor.models.some((m) => m.name === input.value.trim());
      ok.textContent = exists ? 'Replace' : 'Save';
      ok.disabled = p !== null;
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!ok.disabled) ok.click();
      }
    });
    ok.addEventListener('click', () => close(input.value.trim()));
    refresh();
    queueMicrotask(() => input.select());
    return [h('div', { class: 'field' }, h('label', { for: 'save-name' }, 'Model name'), input, err, h('span', { class: 'hint' }, 'Saved in your SNEED models folder as <name>.json.')), h('div', { class: 'btn-row' }, ok, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'))];
  });
}

/** The most a file may weigh before it is refused here (the server and the importer enforce the same limit). */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** A file name as a model name: its stem, with anything a model name may not contain turned into a dash. */
export const nameFromFile = (fileName: string): string => {
  const stem = fileName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/[.-]+$/, '').slice(0, 64);
  return stem;
};

/**
 * Imports an Open-PSA XML file: choose the file and a name, press Import. A refusal is listed in the dialog, each with its line, and
 * nothing changes. Resolves with the imported name, or null when the dialog was closed without importing.
 */
export async function importDialog(editor: Editor): Promise<string | null> {
  await editor.refreshModels();
  return modal('Import an Open-PSA file', (close) => {
    let text: string | null = null;
    const fileErr = h('span', { class: 'field-error', id: 'imp-file-err', role: 'alert', hidden: true });
    const nameErr = h('span', { class: 'field-error', id: 'imp-name-err', role: 'alert', hidden: true });
    const file = h('input', { type: 'file', id: 'imp-file', accept: '.xml,.opsa,text/xml,application/xml', 'aria-describedby': 'imp-file-err', 'data-field': 'import-file' }) as HTMLInputElement;
    const name = h('input', { type: 'text', id: 'imp-name', maxlength: 64, 'aria-describedby': 'imp-name-err', 'data-field': 'import-name' }) as HTMLInputElement;
    const results = h('div', { class: 'import-results', 'data-testid': 'import-results', 'aria-live': 'polite' });
    const go = h('button', { class: 'btn primary', type: 'button', 'data-testid': 'import-confirm' }, 'Import') as HTMLButtonElement;
    const refresh = (): void => {
      const p = nameProblem(name.value.trim());
      const exists = editor.models.some((m) => m.name === name.value.trim());
      nameErr.hidden = name.value === '' || (p === null && !exists);
      nameErr.textContent = p ?? (exists ? 'A model with this name exists. Choose another name: an import never replaces a model.' : '');
      name.toggleAttribute('aria-invalid', !nameErr.hidden);
      go.disabled = text === null || p !== null || exists;
    };
    file.addEventListener('change', async () => {
      results.replaceChildren();
      const f = file.files?.[0];
      text = null;
      fileErr.hidden = true;
      if (f) {
        if (f.size > MAX_IMPORT_BYTES) {
          fileErr.textContent = 'This file is larger than 2 MB, which is more than a fault tree needs. It was not read.';
          fileErr.hidden = false;
        } else {
          text = await f.text();
          if (name.value === '') name.value = nameFromFile(f.name);
        }
      }
      refresh();
    });
    name.addEventListener('input', refresh);
    go.addEventListener('click', async () => {
      if (text === null) return;
      go.disabled = true;
      const r = await editor.importFile(text, name.value.trim());
      results.replaceChildren();
      if (r?.kind === 'imported') return close(r.name);
      if (r?.kind === 'refused') {
        results.append(
          h('p', { role: 'alert', class: 'import-refused' }, `Not imported: ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} in the file. Nothing was saved and your model is unchanged.`),
          h('ul', { class: 'problems', 'aria-label': 'Problems in the file' }, ...r.errors.map((e) => h('li', { class: 'problem error', 'data-code': e.code }, h('div', { class: 'code' }, `${e.code}${e.line ? ` · line ${e.line}` : ''}`), h('div', { class: 'msg' }, e.message)))),
        );
      } else results.append(h('p', { role: 'alert', class: 'import-refused' }, 'The import could not be completed; see the message at the top of the page.'));
      refresh();
    });
    refresh();
    return [
      h('p', { class: 'hint' }, 'Reads the fault trees SNEED can analyse: basic events with a fixed probability, AND, OR and K-of-N gates. Anything else is refused, with the line it is on. The original file is kept beside the model, unchanged.'),
      h('div', { class: 'field' }, h('label', { for: 'imp-file' }, 'Open-PSA file (.xml)'), file, fileErr),
      h('div', { class: 'field' }, h('label', { for: 'imp-name' }, 'Save the imported model as'), name, nameErr),
      results,
      h('div', { class: 'btn-row' }, go, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel')),
    ];
  });
}

/** True when it is safe to discard the open model: nothing unsaved, or the student agreed. */
export function confirmDiscard(editor: { dirty: boolean }, what = 'model'): boolean {
  return !editor.dirty || window.confirm(`Discard the unsaved changes to this ${what}?`);
}

/** Lists the saved event trees; resolves with the chosen name or null. */
export async function openEventTreeDialog(editor: EventTreeEditor): Promise<string | null> {
  await editor.refreshTrees();
  return modal('Open a saved event tree', (close) => [
    editor.trees.length === 0
      ? h('p', { class: 'hint', 'data-testid': 'no-event-trees' }, 'No saved event trees yet. Use Save to keep the current one.')
      : h('ul', { class: 'model-list', 'aria-label': 'Saved event trees' }, ...editor.trees.map((m) => h('li', {}, h('button', { type: 'button', 'data-tree': m.name, onclick: () => close(m.name) }, h('span', {}, m.name), h('span', { class: 'meta' }, `${new Date(m.modified).toLocaleString()}`))))),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel')),
  ]);
}

/** Asks for a name to save an event tree under; resolves with a valid name or null. */
export async function saveAsEventTreeDialog(editor: EventTreeEditor, suggested: string): Promise<string | null> {
  await editor.refreshTrees();
  return modal('Save the event tree as', (close) => {
    const err = h('span', { class: 'field-error', id: 'save-err', role: 'alert', hidden: true });
    const input = h('input', { type: 'text', id: 'save-name', value: suggested, maxlength: 64, 'aria-describedby': 'save-err', 'data-field': 'save-name' }) as HTMLInputElement;
    const ok = h('button', { class: 'btn primary', type: 'button', 'data-testid': 'save-confirm' }, 'Save') as HTMLButtonElement;
    const refresh = (): void => {
      const p = nameProblem(input.value.trim());
      err.hidden = p === null || input.value === '';
      err.textContent = p ?? '';
      input.toggleAttribute('aria-invalid', p !== null && input.value !== '');
      ok.textContent = editor.trees.some((m) => m.name === input.value.trim()) ? 'Replace' : 'Save';
      ok.disabled = p !== null;
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!ok.disabled) ok.click();
      }
    });
    ok.addEventListener('click', () => close(input.value.trim()));
    refresh();
    queueMicrotask(() => input.select());
    return [h('div', { class: 'field' }, h('label', { for: 'save-name' }, 'Event tree name'), input, err, h('span', { class: 'hint' }, 'Saved in the event-trees folder of your SNEED models folder as <name>.json.')), h('div', { class: 'btn-row' }, ok, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'))];
  });
}
