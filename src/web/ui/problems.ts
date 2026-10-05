import type { Issue } from '../api.js';
import type { Editor } from '../model/editor.js';
import { h, rerender } from './dom.js';
import { icon } from './icons.js';
import { PROBLEM_HINTS } from './hints.js';

export class ProblemsPanel {
  readonly el = h('div', { class: 'spanel', id: 'panel-problems', role: 'tabpanel', 'aria-labelledby': 'tab-problems', 'data-testid': 'problems' });
  private last: unknown = Symbol('none');
  constructor(private readonly editor: Editor) {}

  render(): void {
    const v = this.editor.validation;
    if (v === this.last) return;
    this.last = v;
    rerender(this.el, () => {
      if (!v) return [h('p', { class: 'empty-state' }, 'Checking the model…')];
      const items = [...v.errors, ...v.warnings];
      if (items.length === 0) return [h('p', { class: 'empty-state', 'data-testid': 'no-problems' }, 'No problems. The model is ready to run.')];
      return [
        h('p', { class: 'hint' }, v.errors.length ? `${v.errors.length} problem${v.errors.length === 1 ? '' : 's'} must be fixed before the model can run.` : 'Only warnings: the model can run.'),
        h('ul', { class: 'problems', 'aria-label': 'Problems in the model' }, ...items.map((i) => this.item(i))),
      ];
    });
  }

  private item(i: Issue): HTMLElement {
    const ids = i.ids ?? [];
    return h('li', { class: `problem ${i.severity}`, 'data-code': i.code },
      h('div', { class: 'code' }, icon(i.severity === 'error' ? 'error' : 'warn'), ` ${i.code}`),
      h('div', { class: 'msg' }, i.message),
      PROBLEM_HINTS[i.code] ? h('div', { class: 'why' }, PROBLEM_HINTS[i.code]) : null,
      ids.length ? h('button', { class: 'btn', type: 'button', 'aria-label': `Select ${ids.join(' and ')} in the drawing`, onclick: () => this.editor.selectIssue(i) }, `Select ${ids.slice(0, 2).join(', ')}`) : null);
  }
}
