import type { Editor } from '../model/editor.js';
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

/** True when it is safe to discard the open model: nothing unsaved, or the student agreed. */
export function confirmDiscard(editor: Editor): boolean {
  return !editor.dirty || window.confirm('Discard the unsaved changes to this model?');
}
