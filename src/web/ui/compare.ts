// The Compare tab: two saved runs, what differs in the model and what differs in the result. A difference is shown as a
// difference; the view never calls one run better or safer than the other. State is in words, not colour alone.

import type { RunInfo } from '../api.js';
import type { Editor } from '../model/editor.js';
import { h, rerender, type Child } from './dom.js';
import { fmt } from './results.js';

const label = (r: RunInfo): string => {
  const when = r.modified.replace('T', ' ').slice(0, 19);
  const result = r.status === 'completed' ? fmt(r.top_event_probability) : (r.status ?? 'unreadable');
  // the result comes right after the time: the side panel is narrow and a long option is cut off at the end
  return `${when} · ${result} · ${r.method ?? '?'} · ${r.model_name ?? 'unnamed model'}`;
};
const signed = (d: number): string => `${d > 0 ? '+' : d < 0 ? '-' : ''}${fmt(Math.abs(d))}`;
const list = (ids: string[]): string => ids.join(', ');

export class ComparePanel {
  readonly el = h('div', { class: 'spanel', id: 'panel-compare', role: 'tabpanel', 'aria-labelledby': 'tab-compare', 'data-testid': 'compare' });
  private signature = '';
  private a = '';
  private b = '';
  /** The student has picked a run themselves; until then the choice follows the two newest runs as new ones arrive. */
  private chosen = false;

  constructor(private readonly editor: Editor) {}

  render(): void {
    const ed = this.editor;
    const ids = ed.runs.map((r) => r.id);
    // keep the student's own choice while it is still on offer; otherwise earlier = the second newest run and later = the newest
    if (!this.chosen || !ids.includes(this.a) || !ids.includes(this.b)) {
      this.b = ids[0] ?? '';
      this.a = ids[1] ?? '';
    }
    const sig = JSON.stringify([ids, this.a, this.b, ed.comparison?.a.id, ed.comparison?.b.id, ed.compareError, ed.runsError]);
    if (sig === this.signature) return;
    this.signature = sig;
    rerender(this.el, () => this.content());
  }

  private select(name: 'a' | 'b', text: string): HTMLElement {
    const ed = this.editor;
    const sel = h('select', { id: `cmp-${name}`, 'data-field': `compare-${name}`, onchange: (e) => {
      this[name] = (e.target as HTMLSelectElement).value;
      this.chosen = true;
      this.signature = '';
      this.render();
    } }, ...ed.runs.map((r) => h('option', { value: r.id, selected: r.id === this[name] }, label(r))));
    return h('div', { class: 'field' }, h('label', { for: `cmp-${name}` }, text), sel);
  }

  private content(): Child[] {
    const ed = this.editor;
    const out: Child[] = [
      h('p', { class: 'hint' }, 'Compare two saved runs. Each run keeps the exact model it analysed. Differences are shown as differences: nothing here says one run is better or safer.'),
    ];
    // a failure to read the list is shown as that, never as "no saved runs"
    if (ed.runsError) out.push(h('div', { class: 'notice error', role: 'alert', 'data-testid': 'runs-error' }, ed.runsError));
    if (ed.runs.length < 2) {
      if (ed.runsError) return out;
      out.push(h('p', { class: 'empty-state', 'data-testid': 'compare-need-two' }, ed.runs.length === 0 ? 'No saved runs yet. Press Run, change something, and run again.' : 'Only one saved run so far. Change something and run again to compare.'));
      return out;
    }
    out.push(
      this.select('a', 'Earlier run'),
      this.select('b', 'Later run'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', 'data-testid': 'compare-go', disabled: this.a === this.b, onclick: () => void ed.compareRuns(this.a, this.b) }, 'Compare'),
        this.a === this.b ? h('span', { class: 'hint' }, 'Choose two different runs.') : null),
    );
    if (ed.compareError) out.push(h('div', { class: 'notice error', role: 'alert', 'data-testid': 'compare-error' }, ed.compareError));
    const c = ed.comparison;
    if (!c) return out;

    out.push(h('div', { 'data-testid': 'compare-result' }, ...this.result(c)));
    return out;
  }

  private result(c: NonNullable<Editor['comparison']>): Child[] {
    const out: Child[] = [];
    const r = c.result;
    const m = c.model;
    const named = (id: string): string => {
      const info = this.editor.runs.find((x) => x.id === id);
      return info ? label(info) : id;
    };
    out.push(h('p', { 'data-testid': 'compare-which', 'data-a': c.a.id, 'data-b': c.b.id }, h('strong', {}, 'Earlier: '), named(c.a.id), h('br'), h('strong', {}, 'Later: '), named(c.b.id)));
    out.push(h('h2', {}, 'Result'));
    if (!r) out.push(h('p', { class: 'caveat', role: 'status' }, 'A results file could not be read, so the results are not compared.'));
    else {
      const p = r.probability;
      const sentence =
        p.from === null || p.to === null
          ? `Top probability: ${fmt(p.from)} then ${fmt(p.to)} (one of the runs has no probability, see its status).`
          : p.delta === 0
            ? `Top probability: unchanged at ${fmt(p.to)}.`
            : `Top probability: ${fmt(p.from)} then ${fmt(p.to)} (change ${signed(p.delta!)}${p.ratio !== null ? `, ${fmt(p.ratio)} times the earlier value` : ''}).`;
      out.push(h('p', { 'data-testid': 'compare-probability', 'data-from': String(p.from), 'data-to': String(p.to) }, sentence));
      // each run's own state is always stated, also when both are the same
      const st = (x: { status: string | null; completeness: string | null }): string => `${x.status ?? 'unknown status'} / ${x.completeness ?? 'unknown completeness'}`;
      out.push(h('p', { 'data-testid': 'compare-states' }, `Earlier run: ${st(r.runs.a)}. Later run: ${st(r.runs.b)}.`));
      const solid = (x: { status: string | null; completeness: string | null }): boolean => x.status === 'completed' && x.completeness === 'complete';
      if (!solid(r.runs.a) || !solid(r.runs.b)) {
        out.push(h('div', { class: 'caveat', role: 'status', 'data-testid': 'compare-not-complete' }, h('strong', {}, 'Not a complete result. '), 'At least one of these runs did not finish as completed and complete. Its numbers are for diagnosis only, so the differences below do not describe two valid analyses.'));
      }
      if (r.method) out.push(h('p', {}, `Method: ${r.method.from} then ${r.method.to}.`));
      if (r.engine) out.push(h('p', {}, `Engine: ${r.engine.from} then ${r.engine.to}.`));
      if (r.sameInputs && p.delta !== null && p.delta !== 0) {
        out.push(h('div', { class: 'caveat', role: 'status', 'data-testid': 'compare-unexpected' }, h('strong', {}, 'Unexpected. '), 'The two runs analysed the same model with the same method and engine but the numbers differ. Treat both as unverified until this is explained.'));
      }
      out.push(h('h2', {}, 'Minimal cut sets'));
      const cs = r.cutSets;
      if (cs.added.length + cs.removed.length + cs.changed.length === 0) out.push(h('p', {}, `The same ${cs.unchanged} cut set${cs.unchanged === 1 ? '' : 's'}, with the same probabilities.`));
      else {
        const rows: Child[] = [
          ...cs.removed.map((x) => h('tr', { 'data-change': 'removed' }, h('td', {}, 'Only in the earlier run'), h('td', {}, list(x.events)), h('td', { class: 'num' }, fmt(x.probability)), h('td', { class: 'num' }, '-'))),
          ...cs.added.map((x) => h('tr', { 'data-change': 'added' }, h('td', {}, 'Only in the later run'), h('td', {}, list(x.events)), h('td', { class: 'num' }, '-'), h('td', { class: 'num' }, fmt(x.probability)))),
          ...cs.changed.map((x) => h('tr', { 'data-change': 'changed' }, h('td', {}, 'In both, probability differs'), h('td', {}, list(x.events)), h('td', { class: 'num' }, fmt(x.probability.from)), h('td', { class: 'num' }, fmt(x.probability.to)))),
        ];
        out.push(h('table', { class: 'cutsets', 'aria-label': 'Cut sets that differ', 'data-testid': 'compare-cutsets' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Difference'), h('th', { scope: 'col' }, 'Failures together'), h('th', { scope: 'col' }, 'Earlier'), h('th', { scope: 'col' }, 'Later'))), h('tbody', {}, ...rows)));
        if (cs.unchanged) out.push(h('p', { class: 'hint' }, `${cs.unchanged} other cut set${cs.unchanged === 1 ? ' is' : 's are'} the same in both runs.`));
      }
      if (r.assumptions.length) out.push(h('h2', {}, 'Assumptions'), h('ul', {}, ...r.assumptions.map((a) => h('li', {}, `${a.key}: ${a.from ?? 'not stated'} then ${a.to ?? 'not stated'}`))));
    }

    out.push(h('h2', {}, 'Model'));
    if (!m) out.push(h('p', { class: 'caveat', role: 'status' }, 'A model file could not be read, so the models are not compared.'));
    else if (m.identical && !m.events.changed.length && !m.top) out.push(h('p', { 'data-testid': 'compare-model-same' }, 'The two runs analysed the same model.'));
    else {
      const items: Child[] = [];
      if (m.top) items.push(h('li', {}, `Top event: ${m.top.from || 'none'} then ${m.top.to || 'none'}.`));
      if (m.events.added.length) items.push(h('li', {}, `Events only in the later run: ${list(m.events.added)}.`));
      if (m.events.removed.length) items.push(h('li', {}, `Events only in the earlier run: ${list(m.events.removed)}.`));
      for (const e of m.events.changed) {
        if (e.probability) items.push(h('li', {}, `Event ${e.id}: probability ${fmt(e.probability.from)} then ${fmt(e.probability.to)}.`));
        if (e.name) items.push(h('li', {}, `Event ${e.id}: name ${e.name.from ?? 'none'} then ${e.name.to ?? 'none'} (a name does not change the result).`));
      }
      if (m.gates.added.length) items.push(h('li', {}, `Gates only in the later run: ${list(m.gates.added)}.`));
      if (m.gates.removed.length) items.push(h('li', {}, `Gates only in the earlier run: ${list(m.gates.removed)}.`));
      for (const g of m.gates.changed) {
        if (g.type) items.push(h('li', {}, `Gate ${g.id}: type ${g.type.from} then ${g.type.to}.`));
        if (g.threshold) items.push(h('li', {}, `Gate ${g.id}: K ${g.threshold.from ?? 'none'} then ${g.threshold.to ?? 'none'}.`));
        if (g.inputs) items.push(h('li', {}, `Gate ${g.id}: inputs ${list(g.inputs.from)} then ${list(g.inputs.to)}.`));
      }
      if (m.groups.added.length) items.push(h('li', {}, `Common-cause groups only in the later run: ${list(m.groups.added)}.`));
      if (m.groups.removed.length) items.push(h('li', {}, `Common-cause groups only in the earlier run: ${list(m.groups.removed)}.`));
      for (const g of m.groups.changed) {
        if (g.beta) items.push(h('li', {}, `Group ${g.id}: beta ${fmt(g.beta.from)} then ${fmt(g.beta.to)}.`));
        if (g.members) items.push(h('li', {}, `Group ${g.id}: members ${list(g.members.from)} then ${list(g.members.to)}.`));
      }
      out.push(h('ul', { 'data-testid': 'compare-model-changes' }, ...items));
    }
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => this.editor.clearComparison() }, 'Clear comparison')));
    return out;
  }
}
