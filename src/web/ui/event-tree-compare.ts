// Compare two saved event-tree analyses, under the results of the event-tree view. A difference is shown as a difference: the view never calls one
// analysis better or safer than the other, and numbers are compared only when both analyses are complete.
import type { EtRunInfo } from '../api.js';
import type { EventTreeEditor } from '../model/event-tree-editor.js';
import type { Moved } from '../../core/event-tree-compare.js';
import { h, rerender, type Child } from './dom.js';
import { fmt } from './results.js';

const label = (r: EtRunInfo): string => {
  const when = r.modified.replace('T', ' ').slice(0, 19);
  const result = r.status === 'completed' ? `${fmt(r.total_frequency)} per year` : (r.status ?? 'unreadable');
  return `${when} · ${result} · ${r.tree_name ?? 'unnamed event tree'}`;
};
const signed = (d: number): string => `${d > 0 ? '+' : d < 0 ? '-' : ''}${fmt(Math.abs(d))}`;
const times = (m: Moved): string => (m.ratio === null ? 'n/a' : `×${fmt(m.ratio)}`);

export class EventTreeComparePanel {
  readonly el = h('div', { class: 'et-compare', 'data-testid': 'et-compare' });
  private signature = '';
  private a = '';
  private b = '';
  /** The student has picked analyses themselves; until then the choice follows the two newest as new ones arrive. */
  private chosen = false;

  constructor(private readonly ed: EventTreeEditor) {}

  render(): void {
    const ed = this.ed;
    const ids = ed.runs.map((r) => r.id);
    if (!this.chosen || !ids.includes(this.a) || !ids.includes(this.b)) {
      this.b = ids[0] ?? '';
      this.a = ids[1] ?? '';
    }
    // a comparison on show belongs to the pair it was made for: another choice, by hand or because a newer analysis arrived, removes it
    if (ed.comparison && (ed.comparison.a !== this.a || ed.comparison.b !== this.b)) queueMicrotask(() => ed.clearComparison());
    const sig = JSON.stringify([ids, this.a, this.b, ed.comparison?.a, ed.comparison?.b, ed.comparison?.diff, ed.compareError, ed.runsError]);
    if (sig === this.signature) return;
    this.signature = sig;
    rerender(this.el, () => this.content());
  }

  private select(name: 'a' | 'b', text: string): HTMLElement {
    const sel = h('select', { id: `et-cmp-${name}`, 'data-field': `et-compare-${name}`, onchange: (e) => {
      this[name] = (e.target as HTMLSelectElement).value;
      this.chosen = true;
      this.ed.clearComparison();
      this.signature = '';
      this.render();
    } }, ...this.ed.runs.map((r) => h('option', { value: r.id, selected: r.id === this[name] }, label(r))));
    return h('div', { class: 'field' }, h('label', { for: `et-cmp-${name}` }, text), sel);
  }

  private moved(m: Moved | null): string {
    return m === null ? 'no change' : `${fmt(m.from)} → ${fmt(m.to)} (${signed(m.delta)}, ${times(m)})`;
  }

  private content(): Child[] {
    const ed = this.ed;
    const out: Child[] = [
      h('h2', {}, 'Compare saved analyses'),
      h('p', { class: 'hint' }, 'Compare two saved analyses of event trees. Differences are shown as differences: nothing here says one analysis is better or safer.'),
    ];
    if (ed.runsError) out.push(h('div', { class: 'notice error', role: 'alert', 'data-testid': 'et-runs-error' }, ed.runsError));
    if (ed.runs.length < 2) {
      out.push(h('p', { class: 'empty-state', 'data-testid': 'et-compare-empty' }, ed.runsError ? 'The list of saved analyses could not be read.' : ed.runs.length === 0 ? 'No saved analyses yet. Press Analyse to make one.' : 'One saved analysis so far. Comparing needs two.'));
      return out;
    }
    out.push(this.select('a', 'Earlier analysis'), this.select('b', 'Later analysis'));
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-action': 'et-compare', disabled: this.a === this.b, onclick: () => void ed.compare(this.a, this.b) }, 'Compare'),
      ed.comparison || ed.compareError ? h('button', { class: 'btn', type: 'button', onclick: () => ed.clearComparison() }, 'Clear') : null));
    if (this.a === this.b) out.push(h('p', { class: 'hint' }, 'Choose two different analyses.'));
    if (ed.compareError) out.push(h('div', { class: 'notice error', role: 'alert', 'data-testid': 'et-compare-error' }, ed.compareError));
    const c = ed.comparison;
    if (!c || c.a !== this.a || c.b !== this.b) return out;
    const d = c.diff;
    const state = (x: { status: string | null; completeness: string | null }): string => `${x.status ?? 'unknown'} / ${x.completeness ?? 'unknown'}`;
    out.push(h('div', { 'data-testid': 'et-compare-result' },
      h('p', {}, `Earlier: ${state(d.runs.a)}. Later: ${state(d.runs.b)}.`),
      d.numbersCompared ? null : h('div', { class: 'caveat', role: 'status', 'data-testid': 'et-compare-nonumbers' }, h('strong', {}, 'No numbers compared. '), d.malformed.a || d.malformed.b ? `The ${d.malformed.a && d.malformed.b ? 'files of both analyses are' : d.malformed.a ? 'file of the earlier analysis is' : 'file of the later analysis is'} damaged: it says it is complete but a total or a row cannot be read, so its numbers are not trusted. Only what the analyses were made from is compared.` : 'At least one of these analyses has no frequencies (it failed or was cancelled), so only what the analyses were made from is compared.'),
      d.sameInputs
        ? h('p', { 'data-testid': 'et-compare-same' }, 'Same event tree, same fault-tree model and same engine build: the numbers should be identical. Any difference below is unexpected.')
        : h('ul', { 'data-testid': 'et-compare-inputs' },
            h('li', {}, d.sameTree ? 'The event tree is the same.' : 'The event tree differs.'),
            h('li', {}, d.sameModel ? 'The fault-tree model is the same.' : 'The fault-tree model differs.'),
            h('li', {}, d.engine ? `The engine differs: ${d.engine.from} → ${d.engine.to}.` : d.engineKnown ? 'The engine is the same.' : 'The engine build is not recorded in one or both files, so it cannot be said to be the same.')),
      d.initiating.name || d.initiating.frequency ? h('p', {}, 'Initiating event: ', d.initiating.name ? `renamed ${d.initiating.name.from} → ${d.initiating.name.to}. ` : '', d.initiating.frequency ? `frequency ${this.moved(d.initiating.frequency)} per year.` : '') : null,
      d.numbersCompared ? h('p', { 'data-testid': 'et-compare-total' }, 'Total frequency: ', this.moved(d.total), d.total ? ' per year.' : '.') : null,
      d.headings.added.length || d.headings.removed.length || d.headings.changed.length
        ? h('div', {}, h('h3', {}, 'Headings'), h('ul', {},
            ...d.headings.added.map((x) => h('li', {}, `Added: ${x}`)),
            ...d.headings.removed.map((x) => h('li', {}, `Removed: ${x}`)),
            ...d.headings.changed.map((x) => h('li', {}, `${x.id}: `, x.name ? `renamed ${x.name.from} → ${x.name.to}` : '', x.name && x.event ? '; ' : '', x.event ? `now fails when ${x.event.to} occurs (was ${x.event.from})` : ''))))
        : null,
      this.groups(d),
      d.numbersCompared ? this.sequences(d) : null,
      d.numbersCompared ? this.endStates(d) : null,
      d.assumptions.length ? h('div', {}, h('h3', {}, 'Assumptions'), h('ul', {}, ...d.assumptions.map((x) => h('li', {}, `${x.key}: ${x.from ?? 'not stated'} → ${x.to ?? 'not stated'}`)))) : null));
    return out;
  }

  private groups(d: NonNullable<EventTreeEditor['comparison']>['diff']): Child {
    const g = d.groups;
    if (!g.used.a && !g.used.b) return null;
    const show = (x: { id: string; members: string[]; beta: number | null }): string => `${x.id}: ${x.members.join(', ')}; beta ${x.beta ?? 'not stated'}`;
    const lines: Child[] = [
      ...g.added.map((x) => h('li', { 'data-group': x.id }, `Only in the later analysis: ${show(x)}`)),
      ...g.removed.map((x) => h('li', { 'data-group': x.id }, `Only in the earlier analysis: ${show(x)}`)),
      ...g.changed.map((x) => h('li', { 'data-group': x.id }, `${x.id}: `, x.members ? `members ${x.members.from.join(', ')} → ${x.members.to.join(', ')}` : '', x.members && x.beta ? '; ' : '', x.beta ? `beta ${x.beta.from ?? 'not stated'} → ${x.beta.to ?? 'not stated'}` : '')),
    ];
    return h('div', { 'data-testid': 'et-compare-groups' },
      h('h3', {}, 'Common-cause groups'),
      h('p', {}, `The earlier analysis ${g.used.a ? 'used' : 'did not use'} common-cause groups; the later one ${g.used.b ? 'used' : 'did not use'} them. A result made with groups is a different kind of result from one made with independent events.`),
      lines.length ? h('ul', {}, ...lines) : h('p', { 'data-testid': 'et-compare-groups-same' }, 'The same groups, with the same members and beta, in both.'));
  }

  private sequences(d: NonNullable<EventTreeEditor['comparison']>['diff']): Child {
    const s = d.sequences;
    if (!s.changed.length && !s.added.length && !s.removed.length) return h('p', { 'data-testid': 'et-compare-seq-same' }, `All ${s.unchanged} sequence frequencies are identical.`);
    return h('div', {},
      h('h3', {}, 'Sequences'),
      s.changed.length
        ? h('table', { class: 'cutsets', 'aria-label': 'Sequences whose frequency or end state changed', 'data-testid': 'et-compare-seqs' },
            h('thead', {}, h('tr', {}, ...['Path', 'Earlier', 'Later', 'Change', 'End state'].map((c) => h('th', { scope: 'col' }, c)))),
            h('tbody', {}, ...s.changed.map((x) => h('tr', { 'data-seq': x.key },
              h('th', { scope: 'row' }, x.words),
              h('td', { class: 'num' }, x.frequency ? fmt(x.frequency.from) : ''),
              h('td', { class: 'num' }, x.frequency ? fmt(x.frequency.to) : ''),
              h('td', { class: 'num' }, x.frequency ? `${signed(x.frequency.delta)} (${times(x.frequency)})` : 'no change'),
              h('td', {}, x.end_state ? `${x.end_state.from} → ${x.end_state.to}` : 'same')))))
        : null,
      s.added.length ? h('p', {}, 'Only in the later analysis: ', s.added.map((x) => `${x.words} (${fmt(x.frequency)} per year)`).join('; '), '.') : null,
      s.removed.length ? h('p', {}, 'Only in the earlier analysis: ', s.removed.map((x) => `${x.words} (${fmt(x.frequency)} per year)`).join('; '), '.') : null,
      h('p', { class: 'hint' }, `${s.unchanged} sequence${s.unchanged === 1 ? '' : 's'} unchanged. Frequencies are per year.`));
  }

  private endStates(d: NonNullable<EventTreeEditor['comparison']>['diff']): Child {
    const e = d.endStates;
    if (!e.changed.length && !e.added.length && !e.removed.length) return h('p', { 'data-testid': 'et-compare-end-same' }, `All ${e.unchanged} end-state frequencies are identical.`);
    return h('div', {},
      h('h3', {}, 'End states'),
      e.changed.length
        ? h('table', { class: 'cutsets', 'aria-label': 'End states whose frequency changed', 'data-testid': 'et-compare-ends' },
            h('thead', {}, h('tr', {}, ...['End state', 'Earlier', 'Later', 'Change'].map((c) => h('th', { scope: 'col' }, c)))),
            h('tbody', {}, ...e.changed.map((x) => h('tr', { 'data-end': x.id },
              h('th', { scope: 'row' }, x.name),
              h('td', { class: 'num' }, fmt(x.frequency.from)),
              h('td', { class: 'num' }, fmt(x.frequency.to)),
              h('td', { class: 'num' }, `${signed(x.frequency.delta)} (${times(x.frequency)})`)))))
        : null,
      e.added.length ? h('p', {}, 'Only in the later analysis: ', e.added.map((x) => `${x.name} (${fmt(x.frequency)} per year)`).join('; '), '.') : null,
      e.removed.length ? h('p', {}, 'Only in the earlier analysis: ', e.removed.map((x) => `${x.name} (${fmt(x.frequency)} per year)`).join('; '), '.') : null);
  }
}
