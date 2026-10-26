// The event-tree editor's state and commands, with no DOM (like Editor for fault trees): the document, what the server says about it, the
// saved fault-tree model it refers to, a run in progress and the result on show. The UI only draws this and calls its methods.
import { diffEventTreeResults, type EtResultDiff } from '../../core/event-tree-compare.js';
import { checkEtLesson, predictionReveal, type EtStudentLesson, type EtLessonProgress, type PredictionReveal } from '../../core/event-tree-lesson.js';
import { ApiError, type EtApi, type EtRunInfo, type EtRunResponse, type EtValidateResponse, type ModelInfo, type RunStatus, type ValidateResponse } from '../api.js';
import type { EtIssue } from '../../core/event-tree.js';
import type { EventTreeResult } from '../../core/event-tree-result.js';
import { pathKey, type Branch } from '../../core/event-tree-paths.js';
import type { Notice } from './editor.js';
import * as E from './event-tree-doc.js';
import { eventTreeSvg } from './event-tree-figure.js';

/** What the editor knows of the saved fault-tree model the headings refer to. */
export interface ModelInfoView {
  name: string;
  hash: string | null;
  top: string;
  events: { id: string; name: string }[];
  gates: { id: string; name: string; inputs: string[] }[];
  /** The common-cause groups of the model (plan 15): headings whose events depend on the same group fail together. */
  groups: { id: string; name: string; members: string[]; beta: number }[];
}

/** A common-cause group and the headings that depend on it. */
export interface GroupLink {
  group: ModelInfoView['groups'][number];
  headings: string[];
}

export interface EtOptions {
  debounceMs?: number;
  now?: () => string;
}

export class EventTreeEditor {
  doc: E.EtDoc;
  fileName: string | null = null;
  validation: EtValidateResponse | null = null;
  models: ModelInfo[] = [];
  trees: ModelInfo[] = [];
  /** The saved model the document names, as it is now on disk; null when it could not be read (the validator says why). */
  model: ModelInfoView | null = null;
  approximation = false;
  running = false;
  queueAhead = 0;
  result: Extract<EtRunResponse, { kind: 'ran' | 'refused' }> | null = null;
  /** Whether the shown result was asked for with the approximation. */
  private resultApproximation = false;
  runError: string | null = null;
  /** Saved analyses offered to Compare (newest first), and the comparison on show. */
  runs: EtRunInfo[] = [];
  runsError: string | null = null;
  comparison: { a: string; b: string; diff: EtResultDiff } | null = null;
  compareError: string | null = null;
  private compareSeq = 0;
  /** The lessons the server offers, and the one being worked, if any. */
  lessons: EtStudentLesson[] = [];
  lessonsError: string | null = null;
  lesson: EtStudentLesson | null = null;
  /** The hand calculation is shown only after the student has analysed the tree (docs/plans/04-lessons.md). */
  calcShown = false;
  /** What is typed in the prediction box, and the number it was when Analyse was pressed: the reveal uses the second, so a guess cannot be changed after seeing the answer. */
  predictionText = '';
  /** The prediction that was typed when the analysis now on show was started, kept WITH that analysis: a rerun that fails, or a guess typed later, cannot change what is shown beside an earlier result. */
  private resultPrediction: { result: unknown; value: number | null } | null = null;
  /** The hash and saved name of the lesson's own fault-tree model: the lesson is complete only for an analysis made with exactly that model. */
  private lessonModelHash: string | null = null;
  notice: Notice | null = null;

  static queuePollMs = 700;
  private savedText = '';
  /** Counts every change to the document, including undo and redo: a view that keeps what a field shows must redraw when it moves, even if the document ends up equal to one it had before (a field holding text that was typed and then undone). */
  revision = 0;
  private undoStack: { doc: E.EtDoc; label: string }[] = [];
  private redoStack: { doc: E.EtDoc; label: string }[] = [];
  /** The most steps of history kept. */
  static readonly HISTORY = 200;
  /** Bumped whenever another document replaces this one (New, Open), so an answer that arrives later for the old one is ignored. */
  private docGen = 0;
  private chooseSeq = 0;
  /** The frequency as typed while it is not a number. The document keeps the last good value, but the tree is not runnable, not saved as if it were whole, and any result is old. */
  frequencyDraft: string | null = null;
  private validatedText: string | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private requestId: string | null = null;
  private serializedFor: { doc: E.EtDoc; text: string } | null = null;
  private readonly debounceMs: number;
  private readonly now: () => string;

  constructor(
    private readonly api: EtApi,
    opts: EtOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.doc = E.newEventTree(null, undefined, this.now());
    this.savedText = this.text;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
  setNotice(kind: Notice['kind'] | null, text = ''): void {
    this.notice = kind ? { kind, text } : null;
    this.emit();
  }

  get text(): string {
    if (this.serializedFor?.doc !== this.doc) this.serializedFor = { doc: this.doc, text: E.serialize(this.doc) };
    return this.serializedFor.text;
  }
  get dirty(): boolean {
    return this.text !== this.savedText || this.frequencyDraft !== null;
  }
  get problems(): EtIssue[] {
    return this.validation ? [...this.validation.errors, ...this.validation.warnings] : [];
  }
  get errorCount(): number {
    return this.validation?.errors.length ?? 0;
  }
  /** The checks on screen are for the text on screen. */
  get checked(): boolean {
    return this.validation !== null && this.validatedText === this.text;
  }
  get canRun(): boolean {
    return !this.running && this.frequencyDraft === null && this.checked && this.validation!.valid;
  }
  get runBlockedReason(): string | null {
    if (this.running) return 'an analysis is in progress';
    if (this.frequencyDraft !== null) return 'the frequency is not a number';
    if (!this.validation || !this.checked) return 'the event tree has not been checked yet';
    if (!this.validation.valid) return `${this.errorCount} problem${this.errorCount === 1 ? '' : 's'} to fix first`;
    return null;
  }
  /** The saved model has changed since this document was last checked against it. */
  get modelChanged(): boolean {
    return this.model !== null && this.model.hash !== null && this.model.hash !== this.doc.fault_tree_model.model_hash;
  }
  /** Sequences that still need an end state. */
  get unsetEnds(): number {
    return this.doc.sequences.filter((s) => s.end_state === '').length;
  }
  /** The shown result describes another tree (or was made with the other approximation setting). */
  get stale(): boolean {
    if (this.result?.kind !== 'ran') return false;
    const r = this.result.record;
    // an edit not yet checked counts as a change: until the check says the meaning is the same, a result must not look current
    return this.frequencyDraft !== null || !this.checked || r.input_hashes.tree_hash !== this.validation?.tree_hash || this.resultApproximation !== this.approximation;
  }

  /** The result on show, when it is a complete one for the tree on screen; null otherwise. */
  get currentRecord(): EventTreeResult | null {
    if (this.result?.kind !== 'ran' || this.stale) return null;
    const r = this.result.record;
    return r.status === 'completed' && r.completeness === 'complete' ? r : null;
  }
  /** The figure of the tree on screen, with the result only while it is current: a drawing never pairs old numbers with a new tree. */
  figureSvg(): string {
    return eventTreeSvg(this.doc, { result: this.result?.kind === 'ran' ? { record: this.result.record, stale: this.stale } : null, frequencyDraft: this.frequencyDraft });
  }

  // ---- validation
  private scheduleValidation(ms = this.debounceMs): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.revalidate(), ms);
  }
  async revalidate(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const mine = ++this.seq;
    const text = this.text;
    try {
      const v = await this.api.validateEventTree(text);
      if (mine === this.seq) {
        this.validation = v;
        this.validatedText = text;
        this.emit();
      }
    } catch (e) {
      if (mine === this.seq) {
        this.validation = null;
        this.setNotice('error', `Could not check the event tree: ${(e as Error).message}`);
      }
    }
  }
  async settle(): Promise<void> {
    await this.revalidate();
  }

  // ---- the saved fault-tree model
  async refreshModels(): Promise<void> {
    try {
      this.models = await this.api.listModels();
    } catch (e) {
      this.setNotice('error', `Could not list the saved models: ${(e as Error).message}`);
    }
    this.emit();
  }
  async refreshRuns(): Promise<void> {
    try {
      this.runs = await this.api.listEventTreeRuns();
      this.runsError = null;
    } catch (e) {
      this.runs = [];
      this.runsError = `Could not list the saved analyses: ${(e as Error).message}`;
    }
    this.emit();
  }
  /** Compares two saved analyses, `a` the earlier. A file that cannot be read says which one, and the previous comparison is not left on show. */
  async compare(a: string, b: string): Promise<void> {
    const mine = ++this.compareSeq;
    this.comparison = null;
    this.compareError = null;
    this.emit();
    try {
      const [ra, rb] = await Promise.all([this.api.loadEventTreeRun(a), this.api.loadEventTreeRun(b)]);
      if (mine !== this.compareSeq) return; // a later choice took over while these were being read
      const diff = diffEventTreeResults(ra.record, rb.record);
      if (!diff) this.compareError = 'One of these files is not an event-tree result, so they cannot be compared.';
      else this.comparison = { a, b, diff };
    } catch (e) {
      if (mine !== this.compareSeq) return;
      this.compareError = `Could not read the saved analyses: ${(e as Error).message}`;
    }
    this.emit();
  }
  clearComparison(): void {
    this.compareSeq++;
    this.comparison = null;
    this.compareError = null;
    this.emit();
  }
  // ---- lessons
  async loadLessons(): Promise<void> {
    try {
      this.lessons = await this.api.eventTreeLessons();
      this.lessonsError = null;
    } catch (e) {
      this.lessons = [];
      this.lessonsError = `Lessons are unavailable: ${(e as Error).message}`;
    }
    this.emit();
  }
  /**
   * Starts a lesson: saves the fault-tree model it ships under its own name and replaces the tree on screen with a new one that refers to it.
   * A model the student saved under that name is NEVER replaced: if the name holds a different model, the lesson's model is saved under a
   * numbered name instead (and says so). The first heading starts on the model's first event, a placeholder frequency of 1 stands in until the
   * student sets the lesson's, and nothing of the lesson's answer is filled in. A start that was overtaken (another document, or an edit made
   * while it was under way) changes nothing.
   */
  async startLesson(id: string): Promise<boolean> {
    const lesson = this.lessons.find((l) => l.id === id);
    if (!lesson) return false;
    const gen = ++this.docGen;
    const before = this.doc;
    const text = JSON.stringify(lesson.model.document, null, 2) + String.fromCharCode(10);
    try {
      const target = await this.freeModelName(lesson.model.name, text);
      if (target.write) await this.api.saveModel(target.name, text);
      const v = await this.api.validate(text);
      if (!v.valid || !v.model_hash) throw new Error('the lesson model is not valid');
      if (gen !== this.docGen || this.doc !== before) return false;
      if (target.name !== lesson.model.name) this.setNotice('info', `A model called ${lesson.model.name} already exists and is not this lesson's, so the lesson's model was saved as ${target.name}. Your model was not changed.`);
      const first = (lesson.model.document as { events?: { id?: string }[] }).events?.[0]?.id ?? 'none';
      let doc = E.newEventTree({ name: target.name, hash: v.model_hash, top: first }, `Lesson: ${lesson.title}`, this.now());
      doc = E.setInitiating(doc, { frequency: 1 }, this.now());
      this.frequencyDraft = null;
      this.doc = doc;
      this.resetHistory();
      this.fileName = null;
      this.savedText = this.text;
      this.result = null;
      this.runError = null;
      this.model = null;
      this.comparison = null;
      this.lesson = lesson;
      this.lessonModelHash = v.model_hash;
      this.calcShown = false;
      this.predictionText = '';
      this.resultPrediction = null;
      this.scheduleValidation(0);
      this.emit();
      await this.refreshModels();
      await this.loadModelInfo();
      return true;
    } catch (e) {
      this.setNotice('error', `Could not start the lesson: ${(e as Error).message}`);
      return false;
    }
  }
  leaveLesson(): void {
    if (!this.lesson) return;
    this.lesson = null;
    this.lessonModelHash = null;
    this.calcShown = false;
    this.predictionText = '';
    this.resultPrediction = null;
    this.emit();
  }
  setPrediction(text: string): void {
    this.predictionText = text;
    this.emit();
  }
  /** The prediction as a number: null when nothing has been typed or what is typed is not a number. */
  get prediction(): number | null {
    const t = this.predictionText.trim();
    const n = Number(t);
    return t === '' || !Number.isFinite(n) || n < 0 ? null : n;
  }
  /** The student has analysed in this lesson at least once (so the hand calculation may be shown). */
  get hasTried(): boolean {
    return this.result?.kind === 'ran';
  }
  showCalculation(): void {
    if (this.lesson && this.hasTried) {
      this.calcShown = true;
      this.emit();
    }
  }
  get lessonProgress(): EtLessonProgress | null {
    return this.lesson ? checkEtLesson(this.lesson, this.doc, this.currentRecord, { prediction: this.prediction, predictionAtResult: this.predictionAtResult, modelHash: this.lessonModelHash }) : null;
  }
  /** The prediction that was typed when the analysis on show was started; null when there was none, or when the analysis on show is not that one. */
  get predictionAtResult(): number | null {
    return this.resultPrediction !== null && this.resultPrediction.result === this.result ? this.resultPrediction.value : null;
  }
  /** The prediction beside the result, with the numbers from the student's own analysis; null until there is a current result made after a prediction. */
  get reveal(): PredictionReveal | null {
    const rec = this.currentRecord;
    const guess = this.predictionAtResult;
    if (!this.lesson?.prediction || !rec || guess === null) return null;
    return predictionReveal(this.lesson, rec, rec.initiating_event.frequency, guess);
  }
  /** A model name for the lesson's model: its own name when that is free or already holds exactly this model, else the first free numbered one. */
  private async freeModelName(base: string, text: string): Promise<{ name: string; write: boolean }> {
    const same = (a: string): boolean => {
      try {
        return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(text));
      } catch {
        return false;
      }
    };
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      try {
        const existing = await this.api.loadModel(name);
        if (same(existing)) return { name, write: false };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { name, write: true };
        throw e;
      }
    }
    throw new Error(`there is no free model name for the lesson (${base}, ${base}-2, ... are all taken by other models)`);
  }
  async refreshTrees(): Promise<void> {
    try {
      this.trees = await this.api.listEventTrees();
    } catch (e) {
      this.setNotice('error', `Could not list the saved event trees: ${(e as Error).message}`);
    }
    this.emit();
  }
  /** Reads the saved model the document names (its events, its gates, its current hash). */
  async loadModelInfo(): Promise<void> {
    const name = this.doc.fault_tree_model.name;
    const mine = ++this.modelSeq;
    let info: ModelInfoView | null = null;
    try {
      const text = await this.api.loadModel(name);
      const m = JSON.parse(text) as { top: string; events: { id: string; name?: string }[]; gates: { id: string; name?: string; inputs?: string[] }[]; common_cause_groups?: { id: string; name?: string; members: string[]; beta: number }[] };
      const v = await this.api.validate(text);
      info = {
        name,
        hash: v.valid ? v.model_hash : null,
        top: m.top,
        events: m.events.map((e) => ({ id: e.id, name: e.name ?? e.id })),
        gates: m.gates.map((g) => ({ id: g.id, name: g.name ?? g.id, inputs: Array.isArray(g.inputs) ? g.inputs : [] })),
        groups: (m.common_cause_groups ?? []).map((g) => ({ id: g.id, name: g.name?.trim() || g.id, members: g.members, beta: g.beta })),
      };
    } catch {
      info = null; // not saved, or not a model: the validator names which
    }
    if (mine !== this.modelSeq || name !== this.doc.fault_tree_model.name) return;
    this.model = info;
    this.emit();
  }
  private modelSeq = 0;

  /** The common-cause groups the event of a heading depends on, found through the gates of the saved model. Empty when the model has none. */
  headingGroups(headingId: string): ModelInfoView['groups'] {
    const m = this.model;
    const h = this.doc.headings.find((x) => x.id === headingId);
    if (!m || !h || m.groups.length === 0) return [];
    const gates = new Map(m.gates.map((g) => [g.id, g]));
    const seen = new Set<string>();
    const events = new Set<string>();
    const walk = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const g = gates.get(id);
      if (g) g.inputs.forEach(walk);
      else events.add(id);
    };
    walk(h.event);
    return m.groups.filter((g) => g.members.some((x) => events.has(x)));
  }
  /** The groups that two or more headings depend on: those headings do not fail independently. */
  get sharedGroups(): GroupLink[] {
    const out: GroupLink[] = [];
    for (const g of this.model?.groups ?? []) {
      const headings = this.doc.headings.filter((h) => this.headingGroups(h.id).some((x) => x.id === g.id)).map((h) => h.id);
      if (headings.length >= 2) out.push({ group: g, headings });
    }
    return out;
  }
  /** Looks again at everything outside the document: the models on disk, the one named, the checks. Called when the page returns to this view. */
  async refreshContext(): Promise<void> {
    await Promise.all([this.refreshModels(), this.refreshTrees(), this.loadModelInfo(), this.refreshRuns()]);
    await this.revalidate();
  }
  /** Points the document at another saved model. Headings whose event the new model does not have keep their text and are named by the check. */
  async chooseModel(name: string): Promise<void> {
    const gen = this.docGen;
    const mine = ++this.chooseSeq;
    let text: string;
    let v: ValidateResponse;
    try {
      text = await this.api.loadModel(name);
      v = await this.api.validate(text);
    } catch (e) {
      if (gen === this.docGen && mine === this.chooseSeq) {
        this.setNotice('error', `Could not read ${name}: ${(e as Error).message}`);
        this.emit(); // the selector goes back to the model the document names
      }
      return;
    }
    if (gen !== this.docGen || mine !== this.chooseSeq) return; // another document, or a later choice, took over meanwhile
    if (!v.valid || !v.model_hash) {
      this.setNotice('error', `${name} is not a valid model (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}): open it in the fault-tree editor and fix it first.`);
      return;
    }
    this.commit(E.setModelRef(this.doc, { name, hash: v.model_hash }, this.now()), 'choosing the fault-tree model');
    await this.loadModelInfo();
  }
  /** "I have looked at the changed model": pins the document to its current hash. Results made for the old model stay marked old. */
  async adoptCurrentModel(): Promise<void> {
    if (!this.model?.hash) return;
    this.commit(E.setModelRef(this.doc, { name: this.model.name, hash: this.model.hash }, this.now()), 'checking against the current model');
    this.setNotice('info', `Checked against the current ${this.model.name}. Run the analysis again: an earlier result describes the old model.`);
  }

  // ---- editing
  private commit(next: E.EtDoc, label: string): void {
    // only a change of meaning or content is an edit: a value written again (0.1 as 0.10) differs only by the time stamp, which is not
    if (E.serialize({ ...next, tree: { ...next.tree, updated: this.doc.tree.updated } }) === this.text) return;
    this.undoStack.push({ doc: this.doc, label });
    if (this.undoStack.length > EventTreeEditor.HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.revision++;
    this.scheduleValidation();
    this.emit();
  }
  /** A new, opened or lesson document starts its own history: undo never goes back into another document. */
  private resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.frequencyDraft !== null;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.frequencyDraft !== null ? 'the frequency being typed' : (this.undoStack.at(-1)?.label ?? null);
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
  /** Goes back one edit (or drops a frequency that is not a number yet). Returns what was undone, or null when there was nothing. */
  undo(): string | null {
    if (this.frequencyDraft !== null) {
      this.frequencyDraft = null;
      this.revision++;
      this.setNotice('info', 'Undid: the frequency being typed.');
      return 'the frequency being typed';
    }
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ doc: this.doc, label: step.label });
    this.restore(step.doc, `Undid: ${step.label}.`);
    return step.label;
  }
  redo(): string | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ doc: this.doc, label: step.label });
    this.restore(step.doc, `Redid: ${step.label}.`);
    return step.label;
  }
  private restore(doc: E.EtDoc, message: string): void {
    const modelBefore = this.doc.fault_tree_model.name;
    // what is known of the model belongs to the document that was on screen: for another model it is dropped at once (not kept until the new one is read), so nothing acts on the wrong model meanwhile
    if (this.model && this.model.name !== doc.fault_tree_model.name) this.model = null;
    this.doc = doc;
    this.revision++;
    this.frequencyDraft = null;
    this.scheduleValidation();
    this.setNotice('info', message);
    if (doc.fault_tree_model.name !== modelBefore || this.model?.name !== doc.fault_tree_model.name) void this.loadModelInfo(); // the model the headings name may have changed
  }
  setApproximation(on: boolean): void {
    this.approximation = on;
    this.emit();
  }
  setTreeName(name: string): void {
    this.commit(E.setTreeName(this.doc, name, this.now()), 'renaming the event tree');
  }
  /** Takes the frequency as typed: a number 0 or more is the new value; anything else is kept as a draft and blocks analysis until fixed. */
  setFrequencyText(v: string): void {
    const t = v.trim();
    const n = Number(t);
    if (t === '' || !Number.isFinite(n) || n < 0) {
      this.frequencyDraft = v;
      this.emit();
      return;
    }
    this.frequencyDraft = null;
    this.setInitiating({ frequency: n });
    this.emit();
  }
  setInitiating(patch: Partial<E.EtDoc['initiating_event']>): void {
    this.commit(E.setInitiating(this.doc, patch, this.now()), 'editing the initiating event');
  }
  /**
   * A change to the headings or to when they are asked changes which paths exist. A path that still exists keeps its end state; one that
   * does not is gone, and a new path has none: the author chooses, because carrying an answer over to a different path would be a guess.
   * Says so when answers were lost.
   */
  private commitPaths(next: E.EtDoc, label: string): void {
    const kept = new Set(next.sequences.map((s) => pathKey(s.path)));
    const lost = this.doc.sequences.filter((s) => s.end_state !== '' && !kept.has(pathKey(s.path))).length;
    this.commit(next, label);
    if (lost > 0) this.setNotice('info', `The paths changed, so ${lost} end state${lost === 1 ? ' choice was' : ' choices were'} dropped. Every sequence on the new list that has none needs one.`);
  }
  addHeading(): void {
    this.commitPaths(E.addHeading(this.doc, this.model?.top ?? this.doc.headings.at(-1)?.event ?? 'none', this.now()), 'adding a heading');
  }
  removeHeading(id: string): void {
    this.commitPaths(E.removeHeading(this.doc, id, this.now()), 'removing a heading');
  }
  moveHeading(id: string, by: -1 | 1): void {
    this.commitPaths(E.moveHeading(this.doc, id, by, this.now()), 'moving a heading');
  }
  patchHeading(id: string, patch: { name?: string; event?: string }): void {
    this.commit(E.patchHeading(this.doc, id, patch, this.now()), 'editing a heading');
  }
  setBypass(id: string, cond: { heading: string; branch: Branch } | null): void {
    this.commitPaths(E.setBypass(this.doc, id, cond, this.now()), 'changing when a heading is asked');
  }
  addEndState(): void {
    this.commit(E.addEndState(this.doc, this.now()), 'adding an end state');
  }
  removeEndState(id: string): void {
    this.commit(E.removeEndState(this.doc, id, this.now()), 'removing an end state');
  }
  patchEndState(id: string, patch: Partial<Omit<E.EtEndState, 'id'>>): void {
    this.commit(E.patchEndState(this.doc, id, patch, this.now()), 'editing an end state');
  }
  setSequenceEnd(key: string, endState: string): void {
    this.commit(E.setSequenceEnd(this.doc, key, endState, this.now()), 'choosing an end state');
  }
  setUnsetEnds(endState: string): void {
    this.commit(E.setUnsetEnds(this.doc, endState, this.now()), 'giving the unset sequences an end state');
  }

  // ---- files
  async newTree(): Promise<void> {
    const gen = ++this.docGen;
    await this.refreshModels();
    if (gen !== this.docGen) return;
    const first = this.models[0];
    let ref: { name: string; hash: string; top: string } | null = null;
    if (first) {
      try {
        const text = await this.api.loadModel(first.name);
        const v = await this.api.validate(text);
        if (v.valid && v.model_hash) ref = { name: first.name, hash: v.model_hash, top: (JSON.parse(text) as { top: string }).top };
      } catch {
        ref = null;
      }
    }
    if (gen !== this.docGen) return;
    this.frequencyDraft = null;
    this.leaveLesson();
    this.doc = E.newEventTree(ref, undefined, this.now());
    this.resetHistory();
    this.fileName = null;
    this.savedText = this.text;
    this.result = null;
    this.runError = null;
    this.model = null;
    this.scheduleValidation(0);
    this.emit();
    await this.loadModelInfo();
  }
  async open(name: string): Promise<boolean> {
    const gen = ++this.docGen;
    try {
      const raw = await this.api.loadEventTree(name);
      if (gen !== this.docGen) return false; // another New or Open was started after this one
      const doc = JSON.parse(raw) as E.EtDoc;
      if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.headings) || !Array.isArray(doc.sequences) || !doc.fault_tree_model || !doc.initiating_event) throw new Error('this file is not an event tree');
      this.frequencyDraft = null;
      this.leaveLesson();
      this.doc = doc;
      this.resetHistory();
      this.fileName = name;
      this.savedText = this.text;
      this.result = null;
      this.runError = null;
      this.model = null;
      this.scheduleValidation(0);
      this.setNotice('info', `Opened ${name}.`);
      await this.loadModelInfo();
      return true;
    } catch (e) {
      this.setNotice('error', `Could not open ${name}: ${(e as Error).message}`);
      return false;
    }
  }
  async save(name?: string): Promise<boolean> {
    const target = name ?? this.fileName;
    if (!target) return false;
    if (this.frequencyDraft !== null) {
      this.setNotice('warning', 'Not saved: the frequency is not a number. Enter a number, 0 or more, first.');
      return false;
    }
    const gen = this.docGen;
    const started = this.doc;
    try {
      const touched = { ...started, tree: { ...started.tree, updated: this.now() } };
      const saved = E.serialize(touched);
      await this.api.saveEventTree(target, saved);
      if (gen === this.docGen) {
        // what reached the disk is `saved`; an edit made while it was being written stays unsaved, and is not overwritten
        if (this.doc === started) this.doc = touched;
        this.savedText = saved;
        this.fileName = target;
        this.scheduleValidation();
      }
      this.setNotice('info', `Saved ${target}.`);
      await this.refreshTrees();
      return true;
    } catch (e) {
      this.setNotice('error', `Could not save: ${(e as Error).message}`);
      return false;
    }
  }

  // ---- run
  async run(): Promise<void> {
    if (this.running) return;
    await this.revalidate();
    const blocked = this.runBlockedReason;
    if (blocked) return this.setNotice('warning', `Analysis blocked: ${blocked}.`);
    const requestId = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const text = this.text;
    const approximation = this.approximation;
    const predictionNow = this.prediction;
    const gen = this.docGen;
    this.running = true;
    this.queueAhead = 0;
    this.requestId = requestId;
    this.runError = null;
    this.setNotice(null);
    this.emit();
    const poll = setInterval(() => void this.pollQueue(requestId), EventTreeEditor.queuePollMs);
    try {
      const r = await this.api.runEventTree(text, approximation, requestId);
      if (r.kind === 'dequeued') this.setNotice('info', 'The analysis was cancelled while it waited its turn. Nothing was run.');
      else if (gen === this.docGen) {
        this.result = r;
        this.resultApproximation = approximation;
        this.resultPrediction = { result: r, value: predictionNow };
        void this.refreshRuns();
      } else void this.refreshRuns(); // another document was put on the screen meanwhile (a lesson, New, Open): this answer is for the old one
    } catch (e) {
      this.runError = e instanceof ApiError ? `${e.message} (${e.code})` : (e as Error).message;
    } finally {
      clearInterval(poll);
      this.running = false;
      this.queueAhead = 0;
      this.requestId = null;
      this.emit();
    }
  }
  private async pollQueue(requestId: string): Promise<void> {
    let st: RunStatus;
    try {
      st = await this.api.runStatus();
    } catch {
      return;
    }
    if (!this.running || this.requestId !== requestId) return;
    const waiting = st.queued.findIndex((q) => q.request_id === requestId);
    const ahead = st.running?.request_id === requestId ? 0 : waiting >= 0 ? waiting + (st.running ? 1 : 0) : 0;
    if (ahead !== this.queueAhead) {
      this.queueAhead = ahead;
      this.emit();
    }
  }
  async cancel(): Promise<void> {
    if (!this.running) return;
    try {
      await this.api.cancel(this.requestId ?? undefined);
    } catch (e) {
      this.setNotice('error', `Could not cancel the analysis: ${(e as Error).message}`);
    }
  }
}
