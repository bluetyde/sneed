// The event-tree view (docs/plans/13-event-trees.md, stage S3). Table first: every part of the tree is a labelled table or form that the
// keyboard and a screen reader can walk, and the numbers come back as tables too. The branching drawing is a later stage (S4).
import type { EventTreeEditor } from '../model/event-tree-editor.js';
import { EVENT_TREE_ASSUMPTIONS_TEXT, endStateLabel, eventTreeFailureText, type EventTreeResult } from '../../core/event-tree-result.js';
import type { EtIssue } from '../../core/event-tree.js';
import { MAX_HEADINGS, pathKey } from '../../core/event-tree-paths.js';
import { h, rerender, type Child } from './dom.js';
import { fmt } from './results.js';
import { confirmDiscard, openEventTreeDialog, saveAsEventTreeDialog } from './dialogs.js';
import { EventTreeComparePanel } from './event-tree-compare.js';
import { EventTreeLessonPanel } from './event-tree-lesson.js';
import { exportEventTreePng, exportEventTreeSvg } from './event-tree-export.js';

const ASSUMPTION_TEXT: Record<string, string> = {
  frequency_unit: 'frequency unit',
  probability_basis: 'heading probabilities are',
  independence: 'basic events are',
  ie_independent_of_events: 'initiating event independent of every basic event',
  success_branches: 'success branches',
};


export class EventTreeView {
  readonly el = h('main', { class: 'et', 'aria-label': 'Event tree editor', 'data-testid': 'et', hidden: true });
  private readonly bar = h('div', { class: 'et-bar', role: 'toolbar', 'aria-label': 'Event tree tools' });
  private readonly edit = h('div', { class: 'et-edit', role: 'region', 'aria-label': 'Event tree', 'data-testid': 'et-edit' });
  private readonly side = h('div', { class: 'et-side', role: 'region', 'aria-label': 'Problems and results', tabindex: 0, 'data-testid': 'et-side' });
  private readonly sideMain = h('div', { 'data-testid': 'et-side-main' });
  private readonly compare: EventTreeComparePanel;
  private readonly lessonPanel: EventTreeLessonPanel;
  private sig = { bar: '', edit: '', side: '' };

  constructor(private readonly ed: EventTreeEditor) {
    this.compare = new EventTreeComparePanel(ed);
    this.lessonPanel = new EventTreeLessonPanel(ed);
    this.lessonPanel.confirmStart = () => confirmDiscard(ed, 'event tree');
    this.side.append(this.lessonPanel.el, this.sideMain, this.compare.el);
    this.el.append(this.bar, h('div', { class: 'et-body' }, this.edit, this.side));
  }

  render(): void {
    if (this.el.hidden) return;
    const e = this.ed;
    const barSig = JSON.stringify([e.running, e.queueAhead, e.canRun, e.runBlockedReason, e.approximation, e.dirty, e.fileName, e.stale, e.canUndo, e.canRedo, e.undoLabel, e.redoLabel, e.result?.kind === 'ran' ? e.result.record.status : null]);
    if (barSig !== this.sig.bar) {
      this.sig.bar = barSig;
      rerender(this.bar, () => this.toolbar());
    }
    const editSig = JSON.stringify([e.doc, e.model, e.models, e.frequencyDraft, e.modelChanged, e.figureSvg(), e.revision]);
    if (editSig !== this.sig.edit) {
      this.sig.edit = editSig;
      rerender(this.edit, () => this.editor());
    }
    const sideSig = JSON.stringify([e.validation, e.result, e.stale, e.running, e.queueAhead, e.runError, e.approximation, e.runBlockedReason, e.doc.end_states.map((s) => [s.id, s.synthetic])]);
    if (sideSig !== this.sig.side) {
      this.sig.side = sideSig;
      rerender(this.sideMain, () => this.sidePanel());
    }
    this.compare.render();
    this.lessonPanel.render();
  }

  // ---------------------------------------------------------------- toolbar
  private toolbar(): Child[] {
    const e = this.ed;
    const b = (action: string, label: string, title: string, onclick: () => void, opts: { primary?: boolean; disabled?: boolean } = {}): HTMLElement =>
      h('button', { class: `btn${opts.primary ? ' primary' : ''}`, type: 'button', 'data-action': `et-${action}`, title, disabled: opts.disabled === true, onclick }, label);
    const pill = e.running ? (e.queueAhead > 0 ? `Waiting for ${e.queueAhead} other run${e.queueAhead === 1 ? '' : 's'}…` : 'Analysing…') : e.runBlockedReason ? `Analysis blocked: ${e.runBlockedReason}` : e.result?.kind === 'ran' && e.result.record.status === 'completed' ? (e.stale ? 'Result out of date' : 'Result is current') : 'Ready to analyse';
    return [
      b('new', 'New', 'Start a new event tree', () => void this.newTree()),
      b('open', 'Open', 'Open a saved event tree', () => void this.open()),
      b('save', 'Save', 'Save the event tree (Ctrl+S)', () => void this.save()),
      b('saveas', 'Save as', 'Save under a new name', () => void this.saveAs()),
      h('span', { class: 'sep', 'aria-hidden': 'true' }),
      b('undo', 'Undo', e.undoLabel ? `Undo: ${e.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)', () => this.undo(), { disabled: !e.canUndo }),
      b('redo', 'Redo', e.redoLabel ? `Redo: ${e.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)', () => this.redo(), { disabled: !e.canRedo }),
      h('span', { class: 'sep', 'aria-hidden': 'true' }),
      b('svg', 'SVG', 'Save the drawing and its result as an SVG file', () => exportEventTreeSvg(e)),
      b('png', 'PNG', 'Save the drawing and its result as a PNG image', () => void exportEventTreePng(e)),
      b('print', 'Print', 'Print the drawing, its result and the tables', () => window.print()),
      h('span', { class: 'sep', 'aria-hidden': 'true' }),
      e.running ? b('cancel', 'Cancel', 'Stop the analysis', () => void e.cancel()) : b('run', 'Analyse', 'Compute the sequence and end-state frequencies', () => void e.run(), { primary: true, disabled: !e.canRun }),
      h('label', { class: 'check', for: 'et-approx' }, h('input', { type: 'checkbox', id: 'et-approx', 'data-field': 'et-approx', checked: e.approximation, disabled: e.running, onchange: (ev) => e.setApproximation((ev.target as HTMLInputElement).checked) }), ' Also show the "success branches ignored" approximation'),
      h('span', { class: `run-pill ${e.running ? 'warn' : e.runBlockedReason ? 'blocked' : 'ok'}`, role: 'status', 'data-testid': 'et-pill', title: e.runBlockedReason ?? '' }, pill),
    ];
  }

  /** Commits a field being typed in first (a text field only commits on change), so Undo undoes the edit the student just made. */
  undo(): void {
    this.flush();
    this.ed.undo();
  }
  redo(): void {
    this.flush();
    this.ed.redo();
  }

  async newTree(): Promise<void> {
    if (!confirmDiscard(this.ed, 'event tree')) return;
    await this.ed.newTree();
  }
  async open(): Promise<void> {
    if (!confirmDiscard(this.ed, 'event tree')) return;
    const name = await openEventTreeDialog(this.ed);
    if (name) await this.ed.open(name);
  }
  async saveAs(): Promise<void> {
    const suggested = this.ed.fileName ?? this.ed.doc.tree.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[.-]+$/g, '').slice(0, 64);
    const name = await saveAsEventTreeDialog(this.ed, suggested);
    if (name) await this.ed.save(name);
  }
  async save(): Promise<void> {
    this.flush();
    if (!(await this.ed.save())) await this.saveAs();
  }

  // ---------------------------------------------------------------- the document
  private field(id: string, label: string, control: HTMLElement, hint?: string, error?: string | null): HTMLElement {
    return h('div', { class: 'field' }, h('label', { for: id }, label), control, error ? h('span', { class: 'field-error', id: `${id}-err`, role: 'alert' }, error) : null, hint ? h('span', { class: 'hint', id: `${id}-hint` }, hint) : null);
  }
  private text(id: string, value: string, onchange: (v: string) => void, extra: Record<string, string | boolean> = {}): HTMLInputElement {
    return h('input', { type: 'text', id, value, 'data-field': id, onchange: (ev) => onchange((ev.target as HTMLInputElement).value), ...extra }) as HTMLInputElement;
  }

  private editor(): Child[] {
    const e = this.ed;
    const d = e.doc;
    const out: Child[] = [];

    out.push(h('h2', {}, 'Event tree'));
    out.push(this.field('et-name', 'Name of this event tree', this.text('et-name', d.tree.name, (v) => e.setTreeName(v.trim() || d.tree.name))));

    // initiating event
    out.push(h('h2', {}, 'Initiating event'));
    out.push(this.field('et-ie-name', 'Name', this.text('et-ie-name', d.initiating_event.name, (v) => e.setInitiating({ name: v.trim() || d.initiating_event.name }))));
    out.push(this.field('et-ie-desc', 'Description', this.text('et-ie-desc', d.initiating_event.description, (v) => e.setInitiating({ description: v }))));
    const freqValue = e.frequencyDraft ?? String(d.initiating_event.frequency);
    const freqError = e.frequencyDraft === null ? null : 'Enter a number, 0 or more (for example 0.1). The tree keeps the last good value until you do.';
    out.push(this.field('et-ie-freq', 'Frequency, per year', this.text('et-ie-freq', freqValue, (v) => e.setFrequencyText(v), { inputmode: 'decimal', 'aria-describedby': freqError ? 'et-ie-freq-err et-ie-freq-hint' : 'et-ie-freq-hint', ...(freqError ? { 'aria-invalid': 'true' } : {}) }), 'How often the initiating event happens. Constant, and independent of every basic event.', freqError));

    // model
    out.push(h('h2', {}, 'Fault-tree model'));
    const names = e.models.map((m) => m.name);
    const current = d.fault_tree_model.name;
    const select = h('select', { id: 'et-model', 'data-field': 'et-model', onchange: (ev) => void e.chooseModel((ev.target as HTMLSelectElement).value) },
      ...(names.includes(current) ? [] : [h('option', { value: current, selected: true }, `${current} (not saved)`)]),
      ...names.map((n) => h('option', { value: n, selected: n === current }, n)));
    out.push(this.field('et-model', 'Headings are events of this saved model', select, 'Every heading refers to an event or gate of this one model, so an event shared by two headings is one event. Save the model in the fault-tree editor first.'));
    if (names.length === 0) out.push(h('p', { class: 'caveat', role: 'status', 'data-testid': 'et-no-models' }, 'There are no saved fault-tree models yet. Build one in the fault-tree editor and save it, then come back.'));
    if (e.modelChanged) {
      out.push(h('div', { class: 'stale-banner', role: 'status', 'data-testid': 'et-model-changed' }, h('strong', {}, 'The model has changed. '), `${current} was saved again after this event tree was last checked against it. Check that the headings still mean what you intend, then `, h('button', { class: 'btn', type: 'button', 'data-action': 'et-adopt', onclick: () => void e.adoptCurrentModel() }, 'check against the current model')));
    }

    // headings
    out.push(h('h2', {}, `Headings (${d.headings.length} of ${MAX_HEADINGS})`));
    out.push(h('p', { class: 'hint' }, 'In the order they act. Each heading works, or fails when its event occurs.'));
    const eventOptions = (sel: string): HTMLElement[] => {
      const known = e.model ? [...e.model.gates.map((g) => ({ id: g.id, label: `${g.id} (gate)${g.name !== g.id ? ` ${g.name}` : ''}` })), ...e.model.events.map((x) => ({ id: x.id, label: `${x.id}${x.name !== x.id ? ` ${x.name}` : ''}` }))] : [];
      const opts = known.map((k) => h('option', { value: k.id, selected: k.id === sel }, k.label));
      if (!known.some((k) => k.id === sel)) opts.unshift(h('option', { value: sel, selected: true }, `${sel} (not in the model)`));
      return opts;
    };
    out.push(h('table', { class: 'cutsets et-headings', 'data-testid': 'et-headings' },
      h('caption', { class: 'visually-hidden' }, 'Headings, in order'),
      h('thead', {}, h('tr', {}, ...['Order', 'Name', 'Fails when this occurs', 'Asked', 'Actions'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...d.headings.map((hd, i) => {
        const earlier = d.headings.slice(0, i);
        const condValue = hd.asked_only_if ? `${hd.asked_only_if.heading}|${hd.asked_only_if.branch}` : '';
        const label = (what: string): string => `${what} of heading ${i + 1}, ${hd.name}`;
        return h('tr', { 'data-heading': hd.id },
          h('th', { scope: 'row' }, String(i + 1)),
          h('td', {}, h('input', { type: 'text', value: hd.name, 'aria-label': label('Name'), 'data-field': `et-h-name-${hd.id}`, onchange: (ev) => e.patchHeading(hd.id, { name: (ev.target as HTMLInputElement).value.trim() || hd.name }) })),
          h('td', {},
            h('select', { 'aria-label': label('Event whose occurrence is the failure'), 'data-field': `et-h-event-${hd.id}`, onchange: (ev) => e.patchHeading(hd.id, { event: (ev.target as HTMLSelectElement).value }) }, ...eventOptions(hd.event)),
            ...e.headingGroups(hd.id).map((g) => h('div', { class: 'hint cc-tag', 'data-testid': `et-h-group-${hd.id}`, 'data-group': g.id }, `Depends on common-cause group ${g.name} (beta ${g.beta})`))),
          h('td', {}, h('select', { 'aria-label': label('When it is asked'), 'data-field': `et-h-ask-${hd.id}`, onchange: (ev) => {
            const v = (ev.target as HTMLSelectElement).value;
            if (!v) e.setBypass(hd.id, null);
            else {
              const [heading, branch] = v.split('|') as [string, 'works' | 'fails'];
              e.setBypass(hd.id, { heading, branch });
            }
          } }, h('option', { value: '', selected: condValue === '' }, 'Always'), ...earlier.flatMap((x) => (['works', 'fails'] as const).map((br) => h('option', { value: `${x.id}|${br}`, selected: condValue === `${x.id}|${br}` }, `Only if ${x.name} ${br}`))))),
          h('td', {}, h('div', { class: 'btn-row' },
            h('button', { class: 'btn', type: 'button', 'aria-label': `Move ${hd.name} up`, disabled: i === 0, 'data-action': `et-up-${hd.id}`, 'data-field': `et-up-${hd.id}`, onclick: () => e.moveHeading(hd.id, -1) }, 'Up'),
            h('button', { class: 'btn', type: 'button', 'aria-label': `Move ${hd.name} down`, disabled: i === d.headings.length - 1, 'data-action': `et-down-${hd.id}`, 'data-field': `et-down-${hd.id}`, onclick: () => e.moveHeading(hd.id, 1) }, 'Down'),
            h('button', { class: 'btn danger', type: 'button', 'aria-label': `Remove ${hd.name}`, disabled: d.headings.length <= 1, 'data-action': `et-remove-${hd.id}`, onclick: () => { e.removeHeading(hd.id); setTimeout(() => this.edit.querySelector<HTMLElement>('[data-field="et-add-heading"]')?.focus(), 30); } }, 'Remove'))));
      }))));
    const shared = e.sharedGroups;
    if (shared.length) {
      const name = new Map(d.headings.map((x) => [x.id, x.name]));
      out.push(h('div', { class: 'cc-result', role: 'note', 'data-testid': 'et-groups-note' },
        h('strong', {}, 'Headings that fail together. '),
        'Headings that depend on the same common-cause group do not fail independently: the analysis counts the shared failure once, so they fail together more often than independent events would.',
        h('ul', {}, ...shared.map((s) => h('li', { 'data-group': s.group.id }, `Group ${s.group.name} (beta ${s.group.beta}): ${s.headings.map((x) => name.get(x) ?? x).join(', ')}.`)))));
    }
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-action': 'et-add-heading', 'data-field': 'et-add-heading', disabled: d.headings.length >= MAX_HEADINGS, onclick: () => e.addHeading() }, 'Add a heading')));

    // end states
    out.push(h('h2', {}, `End states (${d.end_states.length})`));
    out.push(h('p', { class: 'hint' }, 'Name the condition each sequence ends in. The examples are marked as examples: they are not conditions of any real plant.'));
    const usedBy = new Map<string, number>();
    for (const s of d.sequences) usedBy.set(s.end_state, (usedBy.get(s.end_state) ?? 0) + 1);
    out.push(h('table', { class: 'cutsets et-ends', 'data-testid': 'et-ends' },
      h('caption', { class: 'visually-hidden' }, 'End states'),
      h('thead', {}, h('tr', {}, ...['Name', 'Description', 'Example', 'Sequences', 'Actions'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...d.end_states.map((es, i) => h('tr', { 'data-end': es.id },
        h('td', {}, h('input', { type: 'text', value: es.name, 'aria-label': `Name of end state ${i + 1}`, 'data-field': `et-e-name-${es.id}`, onchange: (ev) => e.patchEndState(es.id, { name: (ev.target as HTMLInputElement).value.trim() || es.name }) })),
        h('td', {}, h('input', { type: 'text', value: es.description, 'aria-label': `Description of end state ${es.name}`, 'data-field': `et-e-desc-${es.id}`, onchange: (ev) => e.patchEndState(es.id, { description: (ev.target as HTMLInputElement).value.trim() || es.description }) })),
        h('td', {}, h('input', { type: 'checkbox', checked: es.synthetic, 'aria-label': `${es.name} is an example, not a real plant state`, 'data-field': `et-e-syn-${es.id}`, onchange: (ev) => e.patchEndState(es.id, { synthetic: (ev.target as HTMLInputElement).checked }) })),
        h('td', { class: 'num' }, String(usedBy.get(es.id) ?? 0)),
        h('td', {}, h('button', { class: 'btn danger', type: 'button', 'aria-label': `Remove end state ${es.name}`, disabled: d.end_states.length <= 1, 'data-action': `et-remove-end-${es.id}`, onclick: () => { e.removeEndState(es.id); setTimeout(() => this.edit.querySelector<HTMLElement>('[data-field="et-add-end"]')?.focus(), 30); } }, 'Remove')))))));
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-action': 'et-add-end', 'data-field': 'et-add-end', onclick: () => e.addEndState() }, 'Add an end state')));

    // sequences
    out.push(h('h2', {}, `Sequences (${d.sequences.length})`));
    out.push(h('p', { class: 'hint' }, 'Every path through the headings, listed for you. A heading that is not asked on a path is left out of it. Choose where each one ends.'));
    const headingName = new Map(d.headings.map((x) => [x.id, x.name]));
    const endName = (id: string): string => d.end_states.find((x) => x.id === id)?.name ?? id;
    const unset = e.unsetEnds;
    if (unset > 0) {
      out.push(h('div', { class: 'btn-row' }, h('label', { for: 'et-set-all' }, `${unset} sequence${unset === 1 ? ' has' : 's have'} no end state. Give them all: `),
        h('select', { id: 'et-set-all', 'data-field': 'et-set-all', onchange: (ev) => { const v = (ev.target as HTMLSelectElement).value; if (v) e.setUnsetEnds(v); } }, h('option', { value: '' }, 'choose…'), ...d.end_states.map((x) => h('option', { value: x.id }, x.name)))));
    }
    out.push(h('table', { class: 'cutsets et-seqs', 'data-testid': 'et-seqs' },
      h('caption', { class: 'visually-hidden' }, 'Sequences and their end states'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Sequence'), h('th', { scope: 'col' }, 'Path'), h('th', { scope: 'col' }, 'Ends in'))),
      h('tbody', {}, ...d.sequences.map((s, i) => {
        const key = pathKey(s.path);
        const words = s.path.map((st) => `${headingName.get(st.heading) ?? st.heading} ${st.branch}`).join(', ');
        return h('tr', { 'data-seq': key },
          h('th', { scope: 'row' }, String(i + 1)),
          h('td', {}, words),
          h('td', {}, h('select', { 'aria-label': `End state of sequence ${i + 1}: ${words}`, 'data-field': `et-s-end-${i}`, onchange: (ev) => e.setSequenceEnd(key, (ev.target as HTMLSelectElement).value) },
            h('option', { value: '', selected: s.end_state === '' }, 'choose…'), ...d.end_states.map((x) => h('option', { value: x.id, selected: x.id === s.end_state }, x.name)))));
      }))));
    void endName;

    // drawing: a picture of the tables above, not a second source of numbers
    out.push(h('h2', {}, 'Drawing'));
    out.push(h('p', { class: 'hint' }, 'The same tree as a picture. The tables above hold exactly the same information, in an order a keyboard and a screen reader can follow.'));
    const doc = new DOMParser().parseFromString(e.figureSvg(), 'image/svg+xml').documentElement;
    const svg = document.importNode(doc, true) as unknown as SVGSVGElement;
    svg.removeAttribute('height');
    svg.setAttribute('class', 'et-figure');
    out.push(h('div', { class: 'et-drawing', 'data-testid': 'et-drawing' }, svg));
    return out;
  }

  /** Commits what is being typed (a text field only commits on change): called before Save or Analyse from the keyboard. */
  flush(): void {
    const a = document.activeElement;
    if ((a instanceof HTMLInputElement || a instanceof HTMLSelectElement) && this.el.contains(a)) a.blur();
  }

  // ---------------------------------------------------------------- problems and results
  private sidePanel(): Child[] {
    return [...this.problemsSection(), ...this.resultSection()];
  }

  private problemsSection(): Child[] {
    const e = this.ed;
    const v = e.validation;
    const out: Child[] = [h('h2', {}, 'Problems')];
    if (!v) return [...out, h('p', { class: 'empty-state' }, 'Checking the event tree…')];
    const items: EtIssue[] = [...v.errors, ...v.warnings];
    if (items.length === 0) return [...out, h('p', { class: 'empty-state', 'data-testid': 'et-no-problems' }, 'No problems. The event tree is ready to analyse.')];
    out.push(h('p', { class: 'hint', 'data-testid': 'et-problem-summary' }, v.errors.length ? `${v.errors.length} problem${v.errors.length === 1 ? '' : 's'} must be fixed before the event tree can be analysed.` : 'Only warnings: the event tree can be analysed.'));
    out.push(h('ul', { class: 'problems', 'aria-label': 'Problems in the event tree', 'data-testid': 'et-problems' }, ...items.map((i) => h('li', { class: `problem ${i.severity}`, 'data-code': i.code }, h('div', { class: 'code' }, i.code), h('div', { class: 'msg' }, i.message)))));
    return out;
  }

  private resultSection(): Child[] {
    const e = this.ed;
    const out: Child[] = [h('h2', {}, 'Results')];
    if (e.running) return [...out, h('p', { class: 'empty-state', role: 'status', 'data-testid': 'et-running' }, e.queueAhead > 0 ? `Waiting for ${e.queueAhead} other run${e.queueAhead === 1 ? '' : 's'} to finish before this one starts…` : 'Analysing…')];
    if (e.runError) return [...out, h('div', { class: 'notice error', role: 'alert' }, e.runError)];
    const r = e.result;
    if (!r) {
      return [...out, h('p', { class: 'empty-state', 'data-testid': 'et-no-result' }, e.runBlockedReason ? `No result yet. Analysis is unavailable: ${e.runBlockedReason}.` : 'No result yet. Press Analyse.'), h('p', { class: 'hint' }, 'A result is a frequency per year for each sequence and each end state, under the stated assumptions. It is not a probability of failure and not a plant risk figure.')];
    }
    if (r.kind === 'refused') {
      return [...out, h('p', {}, 'The event tree was refused before the engine started:'), h('ul', { class: 'problems', 'data-testid': 'et-refused' }, ...r.errors.map((x) => h('li', { class: 'problem error', 'data-code': x.code }, h('div', { class: 'code' }, x.code), h('div', { class: 'msg' }, x.message))))];
    }
    return [...out, ...this.record(r.record)];
  }

  private record(rec: EventTreeResult): Child[] {
    const e = this.ed;
    const out: Child[] = [];
    const ok = rec.status === 'completed' && rec.completeness === 'complete';
    out.push(h('div', { class: 'btn-row' }, h('span', { class: `pill ${ok ? 'ok' : rec.status === 'cancelled' ? 'warn' : 'bad'}`, 'data-testid': 'et-result-status' }, ` ${rec.status} / ${rec.completeness}`)));
    if (e.stale) out.push(h('div', { class: 'stale-banner', role: 'status', 'data-testid': 'et-stale' }, h('strong', {}, 'Out of date. '), 'The event tree (or the approximation setting) changed after this analysis, so these numbers describe an earlier version. ', h('button', { class: 'btn', type: 'button', disabled: !e.canRun, onclick: () => void e.run() }, 'Analyse again')));
    if (!ok) {
      return [...out, h('div', { class: 'caveat', role: 'status', 'data-testid': 'et-failed' }, h('strong', {}, 'No result. '), h('ul', {}, ...rec.reasons.map((x) => h('li', {}, eventTreeFailureText(x)))))];
    }
    const withApprox = rec.sequences.some((s) => s.approximation);
    const headingName = new Map(rec.headings.map((x) => [x.id, x.name]));
    const synthetic = new Map(rec.end_states.map((x) => [x.id, x.synthetic]));
    const endName = new Map(rec.end_states.map((x) => [x.id, x.name]));

    out.push(h('div', { class: 'big-number', 'data-testid': 'et-total', 'data-value': String(rec.total?.frequency ?? '') }, fmt(rec.total?.frequency), h('small', {}, `Total frequency of the initiating event "${rec.initiating_event.name}", per year. It is split over the sequences below.`)));

    out.push(h('h3', {}, 'Sequences'));
    out.push(h('table', { class: 'cutsets et-result-seqs', 'aria-label': 'Sequence frequencies', 'data-testid': 'et-result-seqs' },
      h('thead', {}, h('tr', {}, ...['Path', 'Ends in', 'Probability of the path', 'Frequency per year', ...(withApprox ? ['Approximation per year', 'Approximation ÷ exact'] : [])].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...rec.sequences.map((s, i) => {
        const words = s.path.map((st) => `${headingName.get(st.heading) ?? st.heading} ${st.branch}`).join(', ');
        return h('tr', { 'data-seq': s.key },
          h('th', { scope: 'row' }, `${i + 1}. ${words}`),
          h('td', {}, `${endName.get(s.end_state) ?? s.end_state}`),
          h('td', { class: 'num' }, fmt(s.probability)),
          h('td', { class: 'num', 'data-value': String(s.frequency) }, fmt(s.frequency)),
          ...(withApprox ? [h('td', { class: 'num' }, s.approximation ? fmt(s.approximation.frequency) : ''), h('td', { class: 'num' }, s.approximation?.ratio_to_exact == null ? 'n/a' : fmt(s.approximation.ratio_to_exact))] : []));
      }))));

    out.push(h('h3', {}, 'End states'));
    out.push(h('table', { class: 'cutsets et-result-ends', 'aria-label': 'End-state frequencies', 'data-testid': 'et-result-ends' },
      h('thead', {}, h('tr', {}, ...['End state', 'Frequency per year', 'Share of the total', 'Sequences'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...rec.end_states.map((x) => h('tr', { 'data-end': x.id },
        h('th', { scope: 'row' }, endStateLabel(x.name, synthetic.get(x.id) === true)),
        h('td', { class: 'num', 'data-value': String(x.frequency) }, fmt(x.frequency)),
        h('td', { class: 'num' }, fmt(x.probability)),
        h('td', { class: 'num' }, String(x.sequences.length)))))));

    if (rec.total) {
      const t = rec.total;
      out.push(h('p', { class: 'hint', 'data-testid': 'et-partition' }, `Check: the sequence probabilities add up to ${fmt(t.probability_sum)} (they must add to 1; the difference is ${t.partition_error.toExponential(1)}), so the sequences cover every outcome exactly once.`));
    }
    if (rec.approximation) {
      out.push(h('div', { class: 'caveat', role: 'note', 'data-testid': 'et-approximation' }, h('strong', {}, 'Approximation, a different kind of number. '), rec.approximation.note, ` The approximate sequence frequencies add up to ${fmt(rec.approximation.frequency_sum)} per year, not ${fmt(rec.total?.frequency)}.`));
    }
    if (rec.common_cause) {
      out.push(h('div', { class: 'cc-result', role: 'note', 'data-testid': 'et-common-cause' },
        h('strong', {}, 'Common-cause groups used (beta-factor). '),
        'This is a different kind of result from one with independent events.',
        h('ul', {}, ...rec.common_cause.groups.map((g) => h('li', { 'data-group': g.id }, `${g.id}: ${g.members.join(', ')}; beta ${g.beta}`)))));
    }
    for (const c of rec.caveats) out.push(h('div', { class: 'caveat', role: 'note', 'data-testid': 'et-caveat' }, h('strong', {}, 'Note. '), c));
    for (const w of rec.warnings) out.push(h('div', { class: 'caveat', role: 'note' }, h('strong', {}, 'Warning. '), w));

    out.push(h('h3', {}, 'Assumptions'));
    out.push(h('dl', { class: 'kv', 'data-testid': 'et-assumptions' }, ...Object.entries(rec.assumptions).flatMap(([k, v]) => [h('dt', {}, ASSUMPTION_TEXT[k] ?? k), h('dd', {}, String(v))])));
    out.push(h('p', { class: 'hint' }, EVENT_TREE_ASSUMPTIONS_TEXT));
    out.push(h('h3', {}, 'How this was produced'));
    out.push(h('dl', { class: 'kv' },
      h('dt', {}, 'Engine'), h('dd', {}, `${rec.engine.name} ${rec.engine.version}`),
      h('dt', {}, 'Engine build'), h('dd', {}, rec.engine.sha256 ? h('code', {}, rec.engine.sha256.slice(0, 16)) : 'not recorded'),
      h('dt', {}, 'Event tree hash'), h('dd', {}, h('code', {}, rec.input_hashes.tree_hash.slice(0, 16))),
      h('dt', {}, 'Fault-tree model hash'), h('dd', {}, h('code', {}, rec.input_hashes.model_hash.slice(0, 16)))));
    return out;
  }
}
