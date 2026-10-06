import type { Editor } from '../model/editor.js';
import { h, rerender, type Child } from './dom.js';
import { icon } from './icons.js';
import { CAVEAT_TEXT, METHOD_TEXT, PROBLEM_HINTS, reasonText } from './hints.js';
import { IMPORTANCE_DEFINITIONS, IMPORTANCE_ASSUMPTIONS } from '../../core/importance.js';

/** Six significant digits, plain notation where that reads well, exponent otherwise. */
export function fmt(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'n/a';
  if (p === 0) return '0';
  const a = Math.abs(p);
  return a >= 1e-3 && a < 1e6 ? String(Number(p.toPrecision(6))) : p.toExponential(3);
}

/** Four significant digits, exponent form for very small or large numbers. */
const fmtImp = (x: number): string => (x === 0 ? '0' : Math.abs(x) < 1e-3 || Math.abs(x) >= 1e5 ? x.toExponential(3) : String(Number(x.toPrecision(4))));

export class ResultsPanel {
  readonly el = h('div', { class: 'spanel', id: 'panel-results', role: 'tabpanel', 'aria-labelledby': 'tab-results', 'data-testid': 'results' });
  private signature = '';
  constructor(private readonly editor: Editor) {}

  render(): void {
    const ed = this.editor;
    const sig = JSON.stringify([ed.result, ed.stale, ed.highlight, ed.running, ed.queueAhead, ed.reuseOffer?.run_id ?? null, ed.reused, ed.importance, ed.importanceBusy, ed.canComputeImportance, ed.runError, ed.method, ed.runBlockedReason, ed.text.length]);
    if (sig === this.signature) return;
    this.signature = sig;
    rerender(this.el, () => this.content());
  }

  /** What the second engine said. A difference is shown as a difference, with the words it was found in. */
  private crossCheck(c: NonNullable<Extract<NonNullable<Editor['result']>, { kind: 'ran' }>['cross']>): HTMLElement {
    if ('unavailable' in c) {
      return h('div', { class: 'caveat', role: 'status', 'data-testid': 'cross-check', 'data-agree': 'unavailable' }, h('strong', {}, 'No second opinion. '), `The second engine could not be run: ${c.reason}.`);
    }
    if (c.agree) {
      return h('div', { class: 'success', role: 'status', 'data-testid': 'cross-check', 'data-agree': 'true' }, h('strong', {}, 'The two engines agree. '), `${c.engine.name} ${c.engine.version} gives the same probability and the same minimal cut sets.`);
    }
    return h('div', { class: 'caveat', role: 'alert', 'data-testid': 'cross-check', 'data-agree': 'false' },
      h('strong', {}, 'The two engines differ. '), 'Treat the numbers as unverified until this is explained.',
      h('ul', {}, ...c.differences.map((d) => h('li', {}, d))));
  }

  /** A saved result for exactly this run exists: say so, and let the student choose. */
  private offer(): Child[] {
    const o = this.editor.reuseOffer;
    if (!o) return [];
    const p = o.result.record.top_event_probability;
    return [
      h('div', { class: 'stale-banner', role: 'status', 'data-testid': 'reuse-offer' },
        h('strong', {}, 'This exact run is already saved. '),
        `Same model, method and engine; run ${o.run_id}, saved ${new Date(o.saved_at).toLocaleString()}${typeof p === 'number' ? `, probability ${p.toPrecision(6)}` : ''}. `,
        h('button', { class: 'btn primary', type: 'button', 'data-testid': 'use-saved', onclick: () => this.editor.useSaved() }, 'Show the saved result'), ' ',
        h('button', { class: 'btn', type: 'button', 'data-testid': 'run-fresh', onclick: () => void this.editor.run({ fresh: true }) }, 'Run again')),
    ];
  }

  /** The importance measures: asked for, never automatic, and tied to the model on screen. */
  private importanceSection(): Child[] {
    const ed = this.editor;
    const imp = ed.importance;
    const out: Child[] = [h('h2', {}, 'Importance measures')];
    out.push(h('p', { class: 'hint' }, 'Which basic events matter most to the top probability, by four exact measures. ', h('button', { class: 'btn', type: 'button', 'data-testid': 'compute-importance', disabled: !ed.canComputeImportance, onclick: () => void ed.computeImportance() }, ed.importanceBusy ? 'Computing…' : imp ? 'Compute again' : 'Compute importance')));
    if (!imp) return out;
    if (imp.kind === 'refused') return [...out, h('div', { class: 'notice error', role: 'alert', 'data-testid': 'importance-refused' }, 'The model is not valid, so there is no table: ', imp.errors.map((e) => e.message).join('; '))];
    if (imp.kind === 'failed') return [...out, h('div', { class: 'caveat', role: 'status', 'data-testid': 'importance-failed' }, h('strong', {}, 'No table. '), imp.message)];
    const dash = (x: number | null): string => (x === null ? '—' : fmtImp(x));
    out.push(h('table', { class: 'cutsets importance', 'aria-label': 'Importance measures of the basic events', 'data-testid': 'importance-table' },
      h('thead', {}, h('tr', {}, ...['Event', 'Probability', 'Birnbaum', 'RAW', 'RRW', 'Fussell-Vesely'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...imp.events.map((e) => h('tr', { 'data-event': e.id },
        h('th', { scope: 'row' }, e.id, e.name ? h('span', { class: 'hint' }, ` ${e.name}`) : null),
        h('td', { class: 'num' }, fmtImp(e.probability)),
        h('td', { class: 'num' }, fmtImp(e.birnbaum)),
        h('td', { class: 'num' }, dash(e.raw)),
        h('td', { class: 'num', title: e.rrwInfinite ? 'The event is in every cut set: removing its failures would remove the top event.' : '' }, e.rrwInfinite ? '∞' : dash(e.rrw)),
        h('td', { class: 'num' }, dash(e.fv)))))));
    out.push(h('p', { class: 'hint' }, `Sorted by Birnbaum importance. Top probability ${fmtImp(imp.top)}, engine ${imp.engine.name} ${imp.engine.version}. "—" means not defined (the top probability is 0).`));
    out.push(h('details', { class: 'defs' }, h('summary', {}, 'What these measures mean'), h('dl', { class: 'kv' }, ...IMPORTANCE_DEFINITIONS.flatMap((d) => [h('dt', {}, d.name), h('dd', {}, d.meaning)])), h('p', { class: 'hint' }, imp.assumptions || IMPORTANCE_ASSUMPTIONS)));
    return out;
  }

  private content(): Child[] {
    return [...this.offer(), ...this.body(), ...this.importanceSection()];
  }

  private body(): Child[] {
    const ed = this.editor;
    if (ed.running) return [h('p', { class: 'empty-state', role: 'status', 'data-testid': 'running' }, ed.queueAhead > 0 ? `Waiting for ${ed.queueAhead} other run${ed.queueAhead === 1 ? '' : 's'} to finish before this one starts…` : 'Running the engine…')];
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
    if (r.kind === 'dequeued') return [];
    const rec = r.record;
    const out: Child[] = [];
    if (ed.reused) out.push(h('div', { class: 'hint', 'data-testid': 'reused' }, `This is a saved result (run ${ed.reused.run_id}, ${new Date(ed.reused.saved_at).toLocaleString()}); nothing was run now.`));
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

    if (r.cross) out.push(this.crossCheck(r.cross));
    out.push(h('h2', {}, 'How this was produced'));
    out.push(h('dl', { class: 'kv' },
      h('dt', {}, 'Engine'), h('dd', {}, `${rec.engine.name} ${rec.engine.version}`),
      h('dt', {}, 'Runtime'), h('dd', {}, rec.engine.name === 'sneed-bdd' ? 'built into the app, nothing to install' : rec.engine.runtime ? `installed, ${rec.engine.runtime.install_id}` : 'not a managed install'),
      h('dt', {}, 'Model hash'), h('dd', {}, h('code', {}, rec.input_hashes.model_hash.slice(0, 16))),
      h('dt', {}, 'Method'), h('dd', {}, `${METHOD_TEXT[rec.method] ?? rec.method}, product-order limit ${rec.settings.limitOrder}`),
      h('dt', {}, 'Assumptions'), h('dd', {}, Object.entries(rec.assumptions).map(([k, v]) => `${k}: ${String(v)}`).join('; '))));
    if (rec.warnings.length) out.push(h('div', {}, h('h2', {}, 'Engine warnings'), h('ul', {}, ...rec.warnings.map((w) => h('li', {}, w)))));
    return out;
  }
}
