import { findEvent, findGate, type GateType } from '../model/doc.js';
import type { Editor } from '../model/editor.js';
import { h, rerender, type Child } from './dom.js';
import { icon } from './icons.js';

const GATE_TYPES: { value: GateType; label: string }[] = [
  { value: 'and', label: 'AND: the gate fails only if all inputs fail' },
  { value: 'or', label: 'OR: the gate fails if any input fails' },
  { value: 'atleast', label: 'K-of-N: the gate fails if at least K inputs fail' },
];

const nodeLabel = (editor: Editor, id: string): string => {
  const n = findEvent(editor.doc, id) ?? findGate(editor.doc, id);
  return n?.name ? `${id}: ${n.name}` : id;
};

/** A labelled field: the label is tied to its control, so screen readers read both. */
function field(idPrefix: string, label: string, control: HTMLElement, extra?: HTMLElement | null): HTMLElement {
  const id = `f-${idPrefix}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, extra);
}

export class Properties {
  readonly el = h('div', { class: 'spanel', id: 'panel-properties', role: 'tabpanel', 'aria-labelledby': 'tab-properties', 'data-testid': 'properties' });
  private signature = '';
  constructor(private readonly editor: Editor) {}

  /** Focuses the first editable field (Enter on a node in the drawing lands here). */
  focusFirst(): void {
    this.el.querySelector<HTMLElement>('input:not([readonly]):not([disabled]), select, textarea')?.focus();
  }

  render(): void {
    const ed = this.editor;
    // selection and document identity only: a validation result arriving while someone types must not rebuild the form
    const sig = `${ed.selected}|${ed.text}`;
    if (sig === this.signature) return;
    this.signature = sig;
    rerender(this.el, () => {
      const n = ed.selected ? ed.visual.byKey.get(ed.selected) : undefined;
      if (!n) return this.modelForm();
      if (n.kind === 'reference') return this.referenceForm(n.id, n.parent!, n.slot);
      if (n.kind === 'missing') return this.missingForm(n.id, n.parent!, n.slot);
      return n.kind === 'event' ? this.eventForm(n.id) : this.gateForm(n.id);
    });
  }

  // ---- model ----
  private modelForm(): HTMLElement[] {
    const ed = this.editor;
    const name = h('input', { type: 'text', value: ed.doc.model.name, 'data-field': 'model-name', maxlength: 200, onchange: (e) => ed.setModelName((e.target as HTMLInputElement).value.trim() || 'Untitled model') }) as HTMLInputElement;
    const top = h('select', { 'data-field': 'top', onchange: (e) => ed.makeTop((e.target as HTMLSelectElement).value) }, h('option', { value: '' }, '(none)'), ...[...ed.doc.gates, ...ed.doc.events].map((n) => h('option', { value: n.id, selected: n.id === ed.doc.top }, nodeLabel(ed, n.id)))) as HTMLSelectElement;
    const a = ed.doc.assumptions as Record<string, string>;
    return [
      h('h2', {}, 'Model'),
      field('model-name', 'Model name', name),
      field('top', 'Top event', top, h('span', { class: 'hint' }, 'The event the whole tree is about. Results are the probability that it occurs.')),
      h('h2', {}, 'Assumptions behind every result'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Probabilities'), h('dd', {}, `${a.probability_model ?? '?'} (fixed numbers, no time)`), h('dt', {}, 'Independence'), h('dd', {}, `${a.independence ?? '?'}: distinct basic events do not influence each other`), h('dt', {}, 'Logic'), h('dd', {}, `${a.coherence ?? '?'}: more failures never repair the system`), h('dt', {}, 'Time'), h('dd', {}, a.time ?? '?')),
      h('p', { class: 'hint' }, 'Select a node in the drawing or in the outline to edit it.'),
    ];
  }

  // ---- basic event ----
  private eventForm(id: string): Child[] {
    const ed = this.editor;
    const e = findEvent(ed.doc, id)!;
    const err = h('span', { class: 'field-error', id: 'err-probability', role: 'alert', hidden: true });
    const prob = h('input', { type: 'number', step: 'any', min: 0, max: 1, value: String(e.probability), 'data-field': 'probability', 'aria-describedby': 'err-probability' }) as HTMLInputElement;
    prob.addEventListener('change', () => {
      const raw = prob.value.trim();
      const v = raw === '' ? Number.NaN : Number(raw);
      if (!Number.isFinite(v)) return this.refuse(prob, err, 'Enter a number from 0 to 1.');
      if (v < 0 || v > 1) return this.refuse(prob, err, `${raw} is outside 0 to 1. A probability cannot be negative or above 1.`);
      prob.removeAttribute('aria-invalid');
      err.hidden = true;
      ed.setProbability(id, v);
    });
    const name = h('input', { type: 'text', value: e.name ?? '', 'data-field': 'name', maxlength: 200, onchange: (ev) => ed.setName(id, (ev.target as HTMLInputElement).value.trim()) }) as HTMLInputElement;
    const kind = e.source?.kind ?? '';
    const source = h('select', { 'data-field': 'source', onchange: (ev) => ed.setSource(id, (ev.target as HTMLSelectElement).value, findEvent(ed.doc, id)?.source?.citation) },
      h('option', { value: '', selected: kind === '' }, 'Not stated'),
      h('option', { value: 'synthetic', selected: kind === 'synthetic' }, 'Synthetic (made up for teaching)'),
      h('option', { value: 'sourced', selected: kind === 'sourced' }, 'From a source (give a citation)'),
      h('option', { value: 'assumed', selected: kind === 'assumed' }, 'Assumed')) as HTMLSelectElement;
    const citation = h('input', { type: 'text', value: e.source?.citation ?? '', 'data-field': 'citation', maxlength: 500, onchange: (ev) => ed.setSource(id, 'sourced', (ev.target as HTMLInputElement).value.trim()) }) as HTMLInputElement;
    const note = h('textarea', { 'data-field': 'note', maxlength: 2000, onchange: (ev) => ed.setNote(id, (ev.target as HTMLTextAreaElement).value) }, e.note ?? '') as HTMLTextAreaElement;
    return [
      h('h2', {}, `Basic event ${id}`),
      field('id', 'ID (fixed)', h('input', { type: 'text', value: id, readonly: true, 'data-field': 'id' })),
      field('name', 'Name', name),
      field('probability', 'Probability that it fails (0 to 1)', prob, err),
      field('source', 'Where the probability comes from', source),
      kind === 'sourced' ? field('citation', 'Citation', citation, h('span', { class: 'hint' }, 'A source needs a citation, or the model is refused.')) : null,
      field('note', 'Note', note),
      this.usedBy(id),
      this.nodeButtons(id),
    ];
  }

  private refuse(input: HTMLInputElement, err: HTMLElement, message: string): void {
    input.setAttribute('aria-invalid', 'true');
    err.textContent = message;
    err.hidden = false;
  }

  /** The gates that use this node, so a repeated event is visibly one event with several uses. */
  private usedBy(id: string): HTMLElement {
    const ed = this.editor;
    const users = ed.doc.gates.map((g) => ({ g, count: g.inputs.filter((x) => x === id).length })).filter((u) => u.count > 0);
    return h('div', {},
      h('h2', {}, 'Used by'),
      users.length === 0
        ? h('p', { class: 'hint' }, id === ed.doc.top ? 'This is the top event.' : 'Nothing uses it yet: it is not part of the analysis.')
        : h('ul', { class: 'inputs', 'aria-label': `Gates that use ${id}` }, ...users.map(({ g, count }) => h('li', {}, h('button', { class: 'linkish', type: 'button', onclick: () => ed.select(g.id) }, `${nodeLabel(ed, g.id)}${count > 1 ? ` (${count} times)` : ''}`)))),
      users.reduce((s, u) => s + u.count, 0) > 1 ? h('p', { class: 'hint' }, 'It is drawn once and shown again as a dashed "repeated reference". It is one failure that affects several gates, not several failures.') : null,
    );
  }

  private nodeButtons(id: string): HTMLElement {
    const ed = this.editor;
    return h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', disabled: ed.doc.top === id, onclick: () => ed.makeTop(id) }, ed.doc.top === id ? 'This is the top event' : 'Make top event'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => ed.deleteSelected() }, 'Delete'));
  }

  // ---- gate ----
  private gateForm(id: string): Child[] {
    const ed = this.editor;
    const g = findGate(ed.doc, id)!;
    const type = h('select', { 'data-field': 'type', onchange: (ev) => ed.setGateType(id, (ev.target as HTMLSelectElement).value as GateType) }, ...GATE_TYPES.map((t) => h('option', { value: t.value, selected: t.value === g.type }, t.label))) as HTMLSelectElement;
    const err = h('span', { class: 'field-error', id: 'err-threshold', role: 'alert', hidden: true });
    const threshold = h('input', { type: 'number', step: 1, min: 1, value: g.threshold === undefined ? '' : String(g.threshold), 'data-field': 'threshold', 'aria-describedby': 'err-threshold' }) as HTMLInputElement;
    threshold.addEventListener('change', () => {
      const v = Number(threshold.value);
      if (!Number.isInteger(v)) return this.refuse(threshold, err, 'K must be a whole number.');
      threshold.removeAttribute('aria-invalid');
      err.hidden = true;
      ed.setThreshold(id, v);
    });
    const n = g.inputs.length;
    const visual = ed.visual;
    const slots = visual.edges.filter((e) => e.from === id).sort((a, b) => a.slot - b.slot);
    const add = h('select', { 'data-field': 'add-input', 'aria-label': `Add an existing node as an input of ${id}` }, ...[...ed.doc.events, ...ed.doc.gates].filter((x) => x.id !== id).map((x) => h('option', { value: x.id }, nodeLabel(ed, x.id)))) as HTMLSelectElement;
    return [
      h('h2', {}, `${g.type === 'atleast' ? 'K-of-N' : g.type.toUpperCase()} gate ${id}`),
      field('id', 'ID (fixed)', h('input', { type: 'text', value: id, readonly: true, 'data-field': 'id' })),
      field('name', 'Name', h('input', { type: 'text', value: g.name ?? '', 'data-field': 'name', maxlength: 200, onchange: (ev) => ed.setName(id, (ev.target as HTMLInputElement).value.trim()) })),
      field('type', 'Gate type', type),
      g.type === 'atleast' ? field('threshold', `K: how many of the ${n} inputs must fail`, threshold, h('span', { class: 'hint' }, `Needs 2 <= K < ${n}.`) ) : null,
      g.type === 'atleast' ? err : null,
      h('h2', {}, `Inputs (${n})`),
      n === 0 ? h('p', { class: 'hint' }, 'No inputs yet. A gate needs at least two.') : h('ul', { class: 'inputs', 'aria-label': `Inputs of ${id}` },
        ...g.inputs.map((input, i) => {
          const child = slots[i] ? visual.byKey.get(slots[i]!.to) : undefined;
          const repeated = child?.kind === 'reference';
          return h('li', {},
            h('button', { class: 'linkish', type: 'button', onclick: () => child && ed.select(child.key) }, `${nodeLabel(ed, input)}${repeated ? ' (repeated)' : ''}${child?.kind === 'missing' ? ' (missing)' : ''}`),
            h('button', { class: 'rm', type: 'button', 'aria-label': `Remove input ${input} from ${id}`, title: 'Remove this input', onclick: () => ed.disconnect(id, i) }, icon('close')));
        })),
      h('div', { class: 'add-row' }, add, h('button', { class: 'btn', type: 'button', onclick: () => add.value && ed.connect(id, add.value) }, 'Add input')),
      h('p', { class: 'hint' }, 'Adding a node that is already used elsewhere makes a repeated reference to the same event, not a copy.'),
      this.usedBy(id),
      this.nodeButtons(id),
    ];
  }

  // ---- repeated reference / missing ----
  private referenceForm(id: string, parent: string, slot: number): HTMLElement[] {
    const ed = this.editor;
    return [
      h('h2', {}, `Repeated reference to ${id}`),
      h('p', {}, `This is the same ${findGate(ed.doc, id) ? 'gate' : 'basic event'} as ${nodeLabel(ed, id)}, used again by ${parent}. It is one thing shown twice, not two copies: if it fails, everything that uses it is affected.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => ed.select(id) }, `Select ${id}`),
        h('button', { class: 'btn danger', type: 'button', onclick: () => ed.disconnect(parent, slot) }, `Remove this input from ${parent}`)),
    ];
  }
  private missingForm(id: string, parent: string, slot: number): HTMLElement[] {
    const ed = this.editor;
    return [
      h('h2', {}, `Missing node ${id}`),
      h('p', {}, `${parent} refers to ${id}, which does not exist in this model. Remove the input, or add a node with that ID.`),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', type: 'button', onclick: () => ed.disconnect(parent, slot) }, `Remove this input from ${parent}`)),
    ];
  }
}
