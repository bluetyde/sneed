import { findEvent, findGate, groups } from '../model/doc.js';
import type { Editor } from '../model/editor.js';
import { readingOrder } from '../model/visual.js';
import { h, rerender } from './dom.js';

/** A plain list of every node in reading order. It is the accessible twin of the drawing: same nodes, same selection. */
export class Outline {
  readonly el = h('nav', { class: 'outline', 'aria-label': 'Outline of the fault tree', 'data-testid': 'outline' });
  private readonly list = h('div', { class: 'pscroll' });
  private signature = '';
  constructor(private readonly editor: Editor) {
    this.el.append(h('div', { class: 'phead' }, 'Outline'), this.list);
  }

  render(): void {
    const ed = this.editor;
    const sev = new Map<string, 'error' | 'warning'>();
    for (const p of ed.problems) for (const id of p.ids ?? []) if (sev.get(id) !== 'error') sev.set(id, p.severity);
    const sig = `${ed.text}|${ed.selected}|${ed.selectedGroup}|${[...sev].join(';')}`;
    if (sig === this.signature) return;
    this.signature = sig;
    const v = ed.visual;
    const order = readingOrder(v);
    // unattached trees come after the top tree; mark where they start
    const firstUnattached = v.roots.length > 1 ? v.roots[1] : null;
    rerender(this.list, () => {
      if (order.length === 0) return [h('p', { class: 'tree-empty' }, 'Empty model.')];
      const items = order.map((key) => {
        const n = v.byKey.get(key)!;
        const node = findGate(ed.doc, n.id) ?? findEvent(ed.doc, n.id);
        const kind = n.kind === 'gate' ? (findGate(ed.doc, n.id)!.type === 'atleast' ? 'K-of-N' : findGate(ed.doc, n.id)!.type.toUpperCase()) : n.kind === 'event' ? 'event' : n.kind === 'reference' ? 'repeat of' : 'missing';
        const mark = sev.get(n.id);
        return h('li', {},
          h('button', { class: 'tree-item', type: 'button', 'data-key': key, 'aria-current': ed.selected === key ? 'true' : null, 'aria-label': `${kind} ${n.id}${node?.name ? ` ${node.name}` : ''}${mark ? (mark === 'error' ? ', has a problem' : ', has a warning') : ''}`, style: `padding-left: ${18 + n.depth * 14}px`, onclick: () => ed.select(key) },
            h('span', { class: 'id' }, n.kind === 'reference' ? `↪ ${n.id}` : n.id),
            h('span', { class: 'nm' }, n.kind === 'gate' || n.kind === 'event' ? [kind, node?.name ? ` · ${node.name}` : ''] : kind),
            mark ? h('span', { class: mark === 'error' ? 'mark-err' : 'mark-warn', 'aria-hidden': 'true' }, '!') : null));
      });
      const out: (HTMLElement | null)[] = [];
      order.forEach((key, i) => {
        if (key === firstUnattached) out.push(h('li', { class: 'tree-group', role: 'presentation' }, 'Not connected to the top event'));
        out.push(items[i]!);
      });
      const gs = groups(ed.doc);
      return [
        h('ul', {}, ...out),
        gs.length === 0 ? null : h('ul', { 'aria-label': 'Common-cause groups', 'data-testid': 'outline-groups' },
          h('li', { class: 'tree-group' }, 'Common-cause groups'),
          ...gs.map((g) => h('li', {}, h('button', { class: 'tree-item', type: 'button', 'data-group': g.id, 'aria-current': ed.selectedGroup === g.id ? 'true' : null, 'aria-label': `Common-cause group ${ed.groupLabel(g.id)}, ${g.members.length} events, beta ${g.beta}`, onclick: () => ed.selectGroup(g.id) },
            h('span', { class: 'id' }, g.id), h('span', { class: 'nm' }, `group · ${g.members.join(', ')}`))))),
      ];
    });
  }
}
