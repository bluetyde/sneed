import type { Editor } from '../model/editor.js';
import { h, rerender, type Child } from './dom.js';
import { icon } from './icons.js';
import { CAVEAT_TEXT, METHOD_TEXT, PROBLEM_HINTS, reasonText } from './hints.js';

/** Six significant digits, plain notation where that reads well, exponent otherwise. */
export function fmt(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'n/a';
  if (p === 0) return '0';
  const a = Math.abs(p);
  return a >= 1e-3 && a < 1e6 ? String(Number(p.toPrecision(6))) : p.toExponential(3);
}

export class ResultsPanel {
  readonly el = h('div', { class: 'spanel', id: 'panel-results', role: 'tabpanel', 'aria-labelledby': 'tab-results', 'data-testid': 'results' });
  private signature = '';
  constructor(private readonly editor: Editor) {}

  render(): void {
    const ed = this.editor;
    const sig = JSON.stringify([ed.result, ed.stale, ed.highlight, ed.running, ed.runError, ed.method, ed.runBlockedReason, ed.text.length]);
    if (sig === this.signature) return;
    this.signature = sig;
    rerender(this.el, () => this.content());
  }

  private content(): Child[] {
    const ed = this.editor;
    if (ed.running) return [h('p', { class: 'empty-state', role: 'status' }, 'Running the engine…')];
    if (ed.runError) return [h('div', { class: 'notice error', role: 'alert' }, ed.runError)];
    const r = ed.result;
    if (!r) {
      return [
        h('p', { class: 'empty-state', 'data-testid': 'no-result' }, ed.runBlockedReason ? `No result yet. Run is unavailable: ${ed.runBlockedReason}.` : 'No result yet. Press Run to analyse the model.'),
        h('p', { class: 'hint' }, 'A result is the probability that the top event occurs under the stated assumptions, plus the smallest combinations of failures that cause it (minimal cut sets). It is not a frequency and not a plant risk figure.'),
      ];
    }
    if (r.kind === 'refused') {
      return [
        h('h2', {}, 'Not run'),
        h('p', {}, 'The model was refused before the engine started:'),
        h('ul', { class: 'problems' }, ...r.errors.map((e) => h('li', { class: 'problem error' }, h('div', { class: 'code' }, e.code), h('div', { class: 'msg' }, e.message), PROBLEM_HINTS[e.code] ? h('div', { class: 'why' }, PROBLEM_HINTS[e.code]) : null))),
      ];
    }
    const rec = r.record;
    const out: Child[] = [];
    const ok = rec.status === 'completed' && rec.completeness === 'complete';
    out.push(h('div', { class: 'btn-row' }, h('span', { class: `pill ${ok ? 'ok' : rec.status === 'truncated' || rec.status === 'cancelled' ? 'warn' : 'bad'}`, 'data-testid': 'result-status' }, icon(ok ? 'check' : 'warn'), ` ${rec.status} / ${rec.completeness}`), h('span', { class: 'hint' }, METHOD_TEXT[rec.method] ?? rec.method)));
    if (ed.stale) {
      out.push(h('div', { class: 'stale-banner', role: 'status', 'data-testid': 'stale' }, h('strong', {}, 'Out of date. '), 'The model or the method changed after this run, so these numbers describe an earlier version. ', h('button', { class: 'btn', type: 'button', disabled: !ed.canRun, onclick: () => void ed.run() }, 'Run again')));
    }
    if (!ok) {
      out.push(h('div', { class: 'caveat', role: 'status' }, h('strong', {}, rec.status === 'truncated' ? 'Not a valid analysis. ' : 'No result. '), rec.reasons.length ? h('ul', {}, ...rec.reasons.map((x) => h('li', {}, reasonText(x)))) : null));
      if (rec.status !== 'truncated') return out;
      out.push(h('p', { class: 'hint' }, 'The numbers below are kept for diagnosis only.'));
    }
    out.push(h('div', { class: 'big-number', 'data-testid': 'top-probability', 'data-value': String(rec.top_event_probability) }, fmt(rec.top_event_probability), h('small', {}, `Probability that the top event occurs${rec.method === 'exact' ? '' : ` (${METHOD_TEXT[rec.method]})`}. Under the stated assumptions; not a frequency.`)));
    for (const c of rec.caveats) out.push(h('div', { class: 'caveat', role: 'note', 'data-testid': 'caveat' }, h('strong', {}, 'Note. '), CAVEAT_TEXT[c] ?? c, rec.approximation_value !== null ? ` The ${METHOD_TEXT[rec.method]?.toLowerCase()} value is ${fmt(rec.approximation_value)}.` : ''));
    if (rec.approximation_value !== null && rec.caveats.length === 0) out.push(h('p', { class: 'hint' }, `${METHOD_TEXT[rec.method]} value: ${fmt(rec.approximation_value)}.`));

    const rows = rec.minimal_cut_sets.map((cs, i) => ({ cs, i })).sort((a, b) => b.cs.probability - a.cs.probability || a.cs.events.length - b.cs.events.length);
    out.push(h('h2', {}, `Minimal cut sets (${rows.length})`));
    out.push(h('p', { class: 'hint' }, 'The smallest combinations of basic events whose failure together makes the top event happen. Choose one to see it on the drawing.'));
    out.push(h('table', { class: 'cutsets', 'aria-label': 'Minimal cut sets' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Failures together'), h('th', { scope: 'col' }, 'Size'), h('th', { scope: 'col' }, 'Probability'))),
      h('tbody', {}, ...rows.map(({ cs, i }) => {
        const selected = ed.highlight.length > 0 && cs.events.length === ed.highlight.length && cs.events.every((e) => ed.highlight.includes(e));
        return h('tr', { class: selected ? 'sel' : '' },
          h('td', {}, h('button', { class: 'row-btn', type: 'button', 'aria-pressed': selected ? 'true' : 'false', 'data-testid': 'cut-set', 'data-events': cs.events.join(','), onclick: () => (selected ? ed.clearExplain() : ed.explainCutSet(i)) }, cs.events.join(' + '))),
          h('td', { class: 'num' }, String(cs.events.length)),
          h('td', { class: 'num' }, fmt(cs.probability)));
      }))));
    if (ed.highlight.length) out.push(h('p', { class: 'explain', role: 'status', 'data-testid': 'explain' }, ed.describeCutSet(ed.highlight)));

    out.push(h('h2', {}, 'How this was produced'));
    out.push(h('dl', { class: 'kv' },
      h('dt', {}, 'Engine'), h('dd', {}, `${rec.engine.name} ${rec.engine.version}`),
      h('dt', {}, 'Runtime'), h('dd', {}, rec.engine.runtime ? `installed, ${rec.engine.runtime.install_id}` : 'not a managed install'),
      h('dt', {}, 'Model hash'), h('dd', {}, h('code', {}, rec.input_hashes.model_hash.slice(0, 16))),
      h('dt', {}, 'Method'), h('dd', {}, `${METHOD_TEXT[rec.method] ?? rec.method}, product-order limit ${rec.settings.limitOrder}`),
      h('dt', {}, 'Assumptions'), h('dd', {}, Object.entries(rec.assumptions).map(([k, v]) => `${k}: ${String(v)}`).join('; '))));
    if (rec.warnings.length) out.push(h('div', {}, h('h2', {}, 'Engine warnings'), h('ul', {}, ...rec.warnings.map((w) => h('li', {}, w)))));
    return out;
  }
}
