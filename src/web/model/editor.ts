// The editor's state and commands, with no DOM: what is selected, the undo history, validation, runs and what is stale.
// The UI only draws this and calls its methods, so everything here is testable without a browser.

import { ApiError, type Api, type Engine, type ImportanceResponse, type ImportResponse, type RanResponse, type RunStatus, type Issue, type Method, type ModelInfo, type RunInfo, type RunResponse, type RuntimeInfo, type SavedRun, type ValidateResponse } from '../api.js';
import { diffModels, diffResults, type ModelDiff, type ResultDiff } from '../../core/compare.js';
import { checkLesson, type EngineResult, type Lesson, type LessonDoc, type LessonProgress } from '../../core/lesson.js';
import { CCF_SUFFIX, INDEPENDENT_SUFFIX } from '../../core/ccf.js';
import * as D from './doc.js';
import { figureSvg } from './figure.js';
import { buildVisual, type Visual } from './visual.js';

export interface Notice {
  kind: 'info' | 'warning' | 'error';
  text: string;
}

interface Snapshot {
  doc: D.Doc;
  label: string;
}

/** Two saved runs side by side. A diff is null when a file could not be read; the view then says which one. */
export interface Comparison {
  a: SavedRun;
  b: SavedRun;
  model: ModelDiff | null;
  result: ResultDiff | null;
}

export interface EditorOptions {
  /** How long to wait after an edit before asking the server to validate. */
  debounceMs?: number;
  now?: () => string;
}

export class Editor {
  doc: D.Doc = D.newModel();
  selected: string | null = null;
  /** The common-cause group being edited, if one is selected (then no node is). */
  selectedGroup: string | null = null;
  fileName: string | null = null;
  validation: ValidateResponse | null = null;
  /** The text the current `validation` is for. While the text on screen differs, the shown result may be for another model. */
  private validatedText: string | null = null;
  runtime: RuntimeInfo | null = null;
  method: Method = 'exact';
  /** Which engine Run uses. The built-in one is the default and needs no install. */
  engine: Engine = 'builtin';
  /** The engine choice the shown result was made with. */
  private resultEngine: Engine = 'builtin';
  /** The importance table: `busy` while it is being made, and what came back for which model. Shown only while it describes the model on screen. */
  importanceBusy = false;
  private importanceData: { text: string; model_hash: string | null; response: Exclude<ImportanceResponse, { kind: 'dequeued' }> } | null = null;
  private importanceSeq = 0;
  private importanceRequestId: string | null = null;
  /** How often, in milliseconds, a run in progress asks the server where it is in the queue. */
  static queuePollMs = 700;
  running = false;
  /** While a run is under way: how many other runs are ahead of it. 0 means this one is running; 2 means it waits behind two. */
  queueAhead = 0;
  private runRequestId: string | null = null;
  /** A saved result for exactly this run, offered instead of running it again. It is only shown while the model, method and engine are the ones it was found for. */
  private offer: { key: string; text: string; run_id: string; saved_at: string; result: RanResponse } | null = null;
  /** True from the press of Run until the run is under way (the lookup for a saved run is in between), so a second press is ignored. */
  private starting = false;
  /** Set when the result on show is a saved one that was reused (nothing was run). */
  reused: { run_id: string; saved_at: string } | null = null;
  result: RunResponse | null = null;
  runError: string | null = null;
  /** Event ids of the cut set being explained, highlighted on the drawing. */
  highlight: string[] = [];
  notice: Notice | null = null;
  models: ModelInfo[] = [];
  /** The lessons the server offers, and the one being worked, if any. */
  lessons: Lesson[] = [];
  lesson: Lesson | null = null;
  /** The hand calculation is shown only after the student has run the model (docs/plans/04-lessons.md). */
  calcShown = false;
  /** Saved runs offered to the Compare view (newest first), and the comparison on show. */
  runs: RunInfo[] = [];
  comparison: Comparison | null = null;
  compareError: string | null = null;
  /** Why the list of saved runs could not be read (shown instead of "no saved runs"). */
  runsError: string | null = null;
  private compareSeq = 0;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private savedText = '';
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private visualFor: { doc: D.Doc; visual: Visual } | null = null;
  private serializedFor: { doc: D.Doc; text: string } | null = null;
  private readonly debounceMs: number;
  private readonly now: () => string;

  constructor(
    private readonly api: Api,
    opts: EditorOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 150;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.savedText = this.text;
    this.scheduleValidation(0);
  }

  // ---- observation ----
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  get text(): string {
    if (this.serializedFor?.doc !== this.doc) this.serializedFor = { doc: this.doc, text: D.serialize(this.doc) };
    return this.serializedFor.text;
  }
  get visual(): Visual {
    if (this.visualFor?.doc !== this.doc) this.visualFor = { doc: this.doc, visual: buildVisual(this.doc) };
    return this.visualFor.visual;
  }
  get dirty(): boolean {
    return this.text !== this.savedText;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
  /** The id of the selected node, whether the selection is a primary node or a repeated reference. */
  get selectedId(): string | null {
    return this.selected ? (this.visual.byKey.get(this.selected)?.id ?? null) : null;
  }
  get problems(): Issue[] {
    return this.validation ? [...this.validation.errors, ...this.validation.warnings] : [];
  }
  get errorCount(): number {
    return this.validation?.errors.length ?? 0;
  }
  /** Run needs a known-valid model and no run in progress, and, for SCRAM alone, the installed runtime. */
  get canRun(): boolean {
    return !this.running && this.validation?.valid === true && !this.scramMissing;
  }
  /** SCRAM is the chosen engine and it is not installed. (With "both", the built-in engine still answers.) */
  get scramMissing(): boolean {
    return this.engine === 'scram' && this.runtime !== null && !this.runtime.installed;
  }
  /** Why Run is unavailable, in words, or null when it is available. */
  get runBlockedReason(): string | null {
    if (this.running) return 'a run is in progress';
    if (this.scramMissing) return 'the SCRAM runtime is not installed: run `npm run runtime -- install`, or choose the built-in engine';
    if (!this.validation) return 'the model has not been checked yet';
    if (!this.validation.valid) return `${this.errorCount} problem${this.errorCount === 1 ? '' : 's'} to fix first`;
    return null;
  }
  private offerKey(): string {
    return `${this.validation?.model_hash ?? ''}|${this.method}|${this.engine}`;
  }
  /** The saved result on offer for the run Run would make now, or null. */
  get reuseOffer(): { run_id: string; saved_at: string; result: RanResponse } | null {
    return this.offer && this.offer.key === this.offerKey() && this.offer.text === this.text ? this.offer : null; // the text too: a change not yet validated must not show a result for the old model
  }
  /** True when the shown result is for an earlier version of the model or another method. */
  get stale(): boolean {
    if (this.result?.kind !== 'ran') return false;
    const r = this.result.record;
    return r.input_hashes.model_hash !== this.validation?.model_hash || r.method !== this.method || this.resultEngine !== this.engine;
  }

  // ---- history ----
  private commit(next: D.Doc, label: string): void {
    if (D.serialize(next) === this.text) return;
    this.undoStack.push({ doc: this.doc, label });
    this.redoStack = [];
    this.doc = next;
    this.afterChange();
  }
  private afterChange(): void {
    this.highlight = [];
    if (this.selected && !this.visual.byKey.has(this.selected)) this.selected = null;
    if (this.selectedGroup && !D.findGroup(this.doc, this.selectedGroup)) this.selectedGroup = null;
    this.scheduleValidation();
    this.emit();
  }
  undo(): string | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push({ doc: this.doc, label: s.label });
    this.doc = s.doc;
    this.afterChange();
    return s.label;
  }
  redo(): string | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push({ doc: this.doc, label: s.label });
    this.doc = s.doc;
    this.afterChange();
    return s.label;
  }

  // ---- selection ----
  select(key: string | null): void {
    if (key !== null && !this.visual.byKey.has(key)) key = null;
    if (key === this.selected && this.selectedGroup === null) return;
    this.selected = key;
    this.selectedGroup = null;
    this.emit();
  }
  /** Selects a common-cause group (it is edited in the Properties panel); no node is selected then. */
  selectGroup(id: string | null): void {
    if (id !== null && !D.findGroup(this.doc, id)) id = null;
    if (id === this.selectedGroup && this.selected === null) return;
    this.selectedGroup = id;
    this.selected = null;
    this.emit();
  }

  /** The gate that new nodes attach to: the selected gate, if a gate is selected. */
  private get attachParent(): string | undefined {
    const n = this.selected ? this.visual.byKey.get(this.selected) : undefined;
    return n && n.kind === 'gate' ? n.id : undefined;
  }

  // ---- editing commands ----
  addEvent(): string {
    const { doc, id } = D.addEvent(this.doc, { ...(this.attachParent ? { parent: this.attachParent } : {}) });
    this.commit(doc, `Add basic event ${id}`);
    this.select(id);
    return id;
  }
  addGate(type: D.GateType): string {
    const { doc, id } = D.addGate(this.doc, type, { ...(this.attachParent ? { parent: this.attachParent } : {}) });
    this.commit(doc, `Add ${type === 'atleast' ? 'K-of-N' : type.toUpperCase()} gate ${id}`);
    this.select(id);
    return id;
  }
  /** Deletes the selected node. For a repeated reference it removes only that input, never the node it points at. */
  deleteSelected(): void {
    if (this.selectedGroup) return this.deleteGroup(this.selectedGroup);
    const n = this.selected ? this.visual.byKey.get(this.selected) : undefined;
    if (!n) return;
    if ((n.kind === 'reference' || n.kind === 'missing') && n.parent) {
      this.commit(D.disconnect(this.doc, n.parent, n.slot), `Remove input from ${n.parent}`);
      this.selected = n.parent;
      this.emit();
      return;
    }
    this.commit(D.removeNode(this.doc, n.id), `Delete ${n.id}`);
    this.selected = null;
    this.emit();
  }
  connect(gateId: string, childId: string): void {
    this.commit(D.connect(this.doc, gateId, childId), `Connect ${childId} to ${gateId}`);
  }
  disconnect(gateId: string, index: number): void {
    this.commit(D.disconnect(this.doc, gateId, index), `Disconnect input ${index + 1} of ${gateId}`);
  }
  makeTop(id: string): void {
    this.commit(D.setTop(this.doc, id), `Make ${id} the top event`);
  }
  setProbability(id: string, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    this.commit(D.setProbability(this.doc, id, value), `Set probability of ${id}`);
    return true;
  }
  // ---- common-cause groups (plan 15) ----
  /** Makes a group of two events that are not in a group yet. The group takes the first event's probability for both. */
  makeGroup(eventId: string, otherId: string): string {
    const before = this.doc;
    const { doc, id } = D.addGroup(before, [eventId, otherId]);
    if (id === '') return '';
    this.commit(doc, `Make a common-cause group ${id} of ${eventId} and ${otherId}${this.changedProbabilities(before, doc)}`);
    this.selectGroup(id);
    this.noteSharedProbability(before, doc);
    return id;
  }
  addToGroup(groupId: string, eventId: string): void {
    const before = this.doc;
    const next = D.addToGroup(before, groupId, eventId);
    this.commit(next, `Add ${eventId} to group ${groupId}${this.changedProbabilities(before, next)}`);
    this.noteSharedProbability(before, next);
  }
  /**
   * The members of a group share one probability, so joining a group can change an event's probability. Say which, with the old and the new
   * value, instead of changing it silently (undo puts it back).
   */
  private changedList(before: D.Doc, after: D.Doc): string[] {
    const was = new Map(before.events.map((e) => [e.id, e.probability]));
    return after.events.filter((e) => was.has(e.id) && was.get(e.id) !== e.probability).map((e) => `${e.id} (${was.get(e.id)} to ${e.probability})`);
  }
  /** The same list as a suffix for the name of the undo step, so the change stays visible after the notice is replaced by another. */
  private changedProbabilities(before: D.Doc, after: D.Doc): string {
    const changed = this.changedList(before, after);
    return changed.length ? `; probability of ${changed.join(' and ')}` : '';
  }
  private noteSharedProbability(before: D.Doc, after: D.Doc): void {
    const changed = this.changedList(before, after);
    if (changed.length === 0) return;
    this.setNotice('warning', `The members of a group share one probability, so ${changed.join(' and ')} changed. Undo puts ${changed.length === 1 ? 'it' : 'them'} back.`);
  }
  removeFromGroup(groupId: string, eventId: string): void {
    this.commit(D.removeFromGroup(this.doc, groupId, eventId), `Remove ${eventId} from group ${groupId}`);
  }
  deleteGroup(groupId: string): void {
    this.commit(D.removeGroup(this.doc, groupId), `Delete group ${groupId}`);
    this.selectGroup(null);
  }
  setBeta(groupId: string, beta: number): boolean {
    if (!Number.isFinite(beta)) return false;
    this.commit(D.setBeta(this.doc, groupId, beta), `Set beta of ${groupId}`);
    return true;
  }
  setGroupName(groupId: string, name: string): void {
    this.commit(D.setGroupName(this.doc, groupId, name), `Rename group ${groupId}`);
  }
  /** Events that can still join a group: the ones that are in none. */
  get ungroupedEvents(): D.EventNode[] {
    return this.doc.events.filter((e) => !D.groupOf(this.doc, e.id));
  }
  /** What a group is called on screen: its name, or its ID. */
  groupLabel(id: string): string {
    return D.findGroup(this.doc, id)?.name?.trim() || id;
  }

  setName(id: string, name: string): void {
    this.commit(D.setName(this.doc, id, name), `Rename ${id}`);
  }
  setNote(id: string, note: string): void {
    this.commit(D.setNote(this.doc, id, note), `Edit note of ${id}`);
  }
  setSource(id: string, kind: string, citation?: string): void {
    this.commit(D.setSource(this.doc, id, kind, citation), `Set source of ${id}`);
  }
  setGateType(id: string, type: D.GateType): void {
    this.commit(D.setGateType(this.doc, id, type), `Change ${id} to ${type === 'atleast' ? 'K-of-N' : type.toUpperCase()}`);
  }
  setThreshold(id: string, k: number): boolean {
    if (!Number.isFinite(k)) return false;
    this.commit(D.setThreshold(this.doc, id, k), `Set threshold of ${id}`);
    return true;
  }
  setModelName(name: string): void {
    this.commit(D.setModelName(this.doc, name), 'Rename the model');
  }
  /** Layout only: it changes where a node is drawn, never the model hash, so results stay current. */
  moveNode(key: string, x: number, y: number): void {
    this.commit(D.moveNode(this.doc, key, Math.round(x), Math.round(y)), 'Move node');
  }
  resetLayout(): void {
    this.commit(D.resetLayout(this.doc), 'Reset the layout');
  }

  // ---- explain ----
  explainCutSet(index: number): void {
    if (this.result?.kind !== 'ran') return;
    const cs = this.result.record.minimal_cut_sets[index];
    this.highlight = cs ? [...cs.events] : [];
    this.emit();
  }
  clearExplain(): void {
    if (this.highlight.length === 0) return;
    this.highlight = [];
    this.emit();
  }
  /** "The top event occurs if A and B both fail." Uses display names where there are any. */
  describeCutSet(events: string[]): string {
    const own = (id: string): string => D.findEvent(this.doc, id)?.name ?? id;
    // a cut set of a model with groups names the group's event and the independent parts (src/core/ccf.ts)
    const label = (id: string): string => (id.endsWith(CCF_SUFFIX) ? `the common cause of group ${this.groupLabel(id.slice(0, -CCF_SUFFIX.length))}` : id.endsWith(INDEPENDENT_SUFFIX) ? `${own(id.slice(0, -INDEPENDENT_SUFFIX.length))} on its own` : own(id));
    const names = events.map(label);
    if (names.length === 1) return `The top event occurs if ${names[0]} fails.`;
    if (names.length === 2) return `The top event occurs if ${names[0]} and ${names[1]} both fail.`;
    return `The top event occurs if ${names.slice(0, -1).join(', ')}, and ${names.at(-1)} all fail.`;
  }

  // ---- problems ----
  /** Selects the first node a problem names, so a click in the Problems list lands on the offender. */
  selectIssue(issue: Issue): void {
    const group = (issue.ids ?? []).find((id) => D.findGroup(this.doc, id));
    if (group) return this.selectGroup(group);
    for (const id of issue.ids ?? []) {
      const key = this.visual.nodes.find((n) => n.id === id && (n.kind === 'event' || n.kind === 'gate'))?.key;
      if (key) return this.select(key);
    }
  }

  // ---- validation ----
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
      const v = await this.api.validate(text);
      if (mine === this.seq) {
        this.validation = v;
        this.validatedText = text;
        this.emit();
      }
    } catch (e) {
      if (mine === this.seq) {
        this.validation = null;
        this.setNotice('error', `Could not check the model: ${(e as Error).message}`);
      }
    }
  }
  /** Resolves when the validation of the current text has finished (used by tests and by Run). */
  async settle(): Promise<void> {
    await this.revalidate();
  }

  async loadHealth(): Promise<void> {
    try {
      this.runtime = (await this.api.health()).runtime;
    } catch (e) {
      this.runtime = { installed: false, message: (e as Error).message };
    }
    this.emit();
  }

  // ---- run ----
  setMethod(method: Method): void {
    if (method === this.method) return;
    this.method = method;
    this.emit();
  }
  setEngine(engine: Engine): void {
    if (engine === this.engine) return;
    this.engine = engine;
    this.emit();
  }
  /**
   * Runs the model. Unless `fresh`, a complete saved result for exactly this run (same model, method and engine build) is offered
   * first and nothing is run: the student chooses between showing it and running again. A lookup that fails just runs.
   * While the engine is busy with another run, this one waits in the server's queue and `queueAhead` says how far back it is.
   */
  async run(opts: { fresh?: boolean } = {}): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      await this.settle(); // run exactly the text that was just checked
      const blocked = this.runBlockedReason;
      if (blocked) return this.setNotice('warning', `Run blocked: ${blocked}.`);
      if (!opts.fresh && this.engine !== 'both') {
        const key = this.offerKey();
        const text = this.text;
        try {
          const hit = await this.api.lookupRun(text, this.method, this.engine);
          if (hit.found && key === this.offerKey() && text === this.text) {
            this.offer = { key, text, run_id: hit.run_id, saved_at: hit.saved_at, result: { kind: 'ran', run_id: hit.run_id, record: hit.record } };
            this.setNotice(null);
            this.emit();
            return;
          }
        } catch {
          /* no lookup: run it */
        }
        if (key !== this.offerKey() || text !== this.text) return; // the model changed while we looked: nothing to run for it
      }
      this.running = true; // from here `running` guards, not `starting`
    } finally {
      this.starting = false;
    }
    this.offer = null;
    this.queueAhead = 0;
    const requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.runRequestId = requestId;
    this.runError = null;
    this.setNotice(null);
    this.emit();
    const poll = setInterval(() => void this.pollQueue(requestId), Editor.queuePollMs);
    try {
      const r = await this.api.run(this.text, this.method, this.engine, requestId);
      if (r.kind === 'dequeued') this.setNotice('info', 'The run was cancelled while it waited its turn. Nothing was run.');
      else {
        this.result = r;
        this.resultEngine = this.engine;
        this.reused = null;
        this.highlight = [];
        void this.refreshRuns();
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'E_SETUP_REQUIRED') this.runtime = { installed: false, code: e.code, message: e.message };
      this.runError = e instanceof ApiError ? `${e.message} (${e.code})` : (e as Error).message;
    } finally {
      clearInterval(poll);
      this.running = false;
      this.queueAhead = 0;
      this.runRequestId = null;
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
    if (!this.running || this.runRequestId !== requestId) return;
    const waiting = st.queued.findIndex((q) => q.request_id === requestId);
    const ahead = st.running?.request_id === requestId ? 0 : waiting >= 0 ? waiting + (st.running ? 1 : 0) : 0;
    if (ahead !== this.queueAhead) {
      this.queueAhead = ahead;
      this.emit();
    }
  }
  /** Shows the saved result that was offered, instead of running. */
  useSaved(): void {
    const o = this.reuseOffer;
    if (!o) return;
    this.result = o.result;
    this.runError = null; // a failed earlier run must not hide the result being shown
    this.resultEngine = this.engine;
    this.reused = { run_id: o.run_id, saved_at: o.saved_at };
    this.highlight = [];
    this.offer = null;
    this.setNotice('info', 'Showing the saved result. Nothing was run.');
    this.emit();
  }
  async cancel(): Promise<void> {
    if (!this.running) return;
    await this.api.cancel(this.runRequestId ?? undefined).catch(() => undefined);
  }

  // ---- compare ----
  async refreshRuns(): Promise<void> {
    try {
      this.runs = await this.api.listRuns();
      this.runsError = null;
    } catch (e) {
      this.runs = [];
      this.runsError = `Could not list the saved runs: ${(e as Error).message}`;
    }
    this.emit();
  }
  /** Loads two saved runs and works out what differs. `a` is shown as the earlier run and `b` as the later one. */
  async compareRuns(idA: string, idB: string): Promise<boolean> {
    this.compareError = null;
    const mine = ++this.compareSeq; // only the newest request may show its answer
    try {
      const [a, b] = await Promise.all([this.api.loadRun(idA), this.api.loadRun(idB)]);
      if (mine !== this.compareSeq) return false;
      const parse = (t: string): unknown => {
        try {
          return JSON.parse(t);
        } catch {
          return null;
        }
      };
      this.comparison = { a, b, model: diffModels(parse(a.model_text), parse(b.model_text)), result: diffResults(a.record, b.record) };
      this.emit();
      return true;
    } catch (e) {
      if (mine !== this.compareSeq) return false;
      this.comparison = null;
      this.compareError = `Could not load the runs: ${(e as Error).message}`;
      this.emit();
      return false;
    }
  }
  clearComparison(): void {
    this.compareSeq++; // a request still in flight must not bring the comparison back
    if (!this.comparison && !this.compareError) return;
    this.comparison = null;
    this.compareError = null;
    this.emit();
  }

  // ---- lessons ----
  async loadLessons(): Promise<void> {
    try {
      this.lessons = await this.api.lessons();
    } catch (e) {
      this.lessons = [];
      this.setNotice('warning', `Lessons are unavailable: ${(e as Error).message}`);
    }
    this.emit();
  }
  /** Starts a lesson from its starting model (an empty one when the lesson gives none). Replaces the current model. */
  startLesson(id: string): boolean {
    const lesson = this.lessons.find((l) => l.id === id);
    if (!lesson) return false;
    this.doc = lesson.start ? D.parseDoc(JSON.stringify(lesson.start)) : D.emptyModel(`Lesson: ${lesson.title}`, this.now());
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null;
    this.fileName = null;
    this.result = null;
    this.runError = null;
    this.savedText = this.text;
    this.lesson = lesson;
    this.calcShown = false;
    this.afterChange();
    return true;
  }
  leaveLesson(): void {
    if (!this.lesson) return;
    this.lesson = null;
    this.calcShown = false;
    this.emit();
  }
  showCalculation(): void {
    if (this.lesson && this.hasTried) {
      this.calcShown = true;
      this.emit();
    }
  }
  /** The student has run the model at least once in this lesson (so the hand calculation may be shown). */
  get hasTried(): boolean {
    return this.result?.kind === 'ran';
  }
  /**
   * The model as the lesson checker reads it: each node is called by its display name when it has a unique one, because a
   * student names their events P1, P2 or S, while the editor's own ids are E1, E2 (the lesson never depends on drawing position).
   */
  private nameOf(): (id: string) => string {
    const counts = new Map<string, number>();
    for (const n of [...this.doc.events, ...this.doc.gates]) {
      const name = n.name?.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const label = new Map<string, string>();
    for (const n of [...this.doc.events, ...this.doc.gates]) {
      const name = n.name?.trim();
      if (name && counts.get(name) === 1) label.set(n.id, name);
    }
    const base = (id: string): string => label.get(id) ?? id;
    // the events a group adds to the analysis are named as the lesson finds them: `<group>.CCF` and `<member>.independent`
    return (id) => (id.endsWith(CCF_SUFFIX) ? this.groupLabel(id.slice(0, -CCF_SUFFIX.length)) + CCF_SUFFIX : id.endsWith(INDEPENDENT_SUFFIX) ? base(id.slice(0, -INDEPENDENT_SUFFIX.length)) + INDEPENDENT_SUFFIX : base(id));
  }
  get lessonDoc(): LessonDoc {
    const nm = this.nameOf();
    return {
      top: nm(this.doc.top),
      events: this.doc.events.map((e) => ({ id: nm(e.id), probability: e.probability })),
      gates: this.doc.gates.map((g) => ({ id: nm(g.id), type: g.type, inputs: g.inputs.map(nm), ...(g.threshold !== undefined ? { threshold: g.threshold } : {}) })),
      common_cause_groups: D.groups(this.doc).map((g) => ({ id: this.groupLabel(g.id), members: g.members.map(nm), beta: g.beta })),
    };
  }
  /** The shown result as the lesson compares it: only a current, completed and complete result counts. */
  get lessonResult(): EngineResult | undefined {
    if (this.result?.kind !== 'ran' || this.stale) return undefined;
    const r = this.result.record;
    if (r.status !== 'completed' || r.completeness !== 'complete' || r.top_event_probability === null) return undefined;
    const nm = this.nameOf();
    return { probability: r.top_event_probability, cutSets: r.minimal_cut_sets.map((c) => c.events.map(nm)) };
  }
  get lessonProgress(): LessonProgress | null {
    return this.lesson ? checkLesson(this.lesson, this.lessonDoc, this.lessonResult) : null;
  }
  // ---- importance ----
  /** The importance table or the reason there is none, for the model on screen now; null when there is none or it is for another model. */
  get importance(): Exclude<ImportanceResponse, { kind: 'dequeued' }> | null {
    const d = this.importanceData;
    if (!d || d.text !== this.text) return null; // any change to the document hides it until it is asked for again
    return d.response;
  }
  /** Stops the importance table, whether it is waiting its turn or being computed. */
  async cancelImportance(): Promise<void> {
    if (!this.importanceBusy || !this.importanceRequestId) return;
    await this.api.cancel(this.importanceRequestId).catch(() => undefined);
  }
  get canComputeImportance(): boolean {
    return !this.importanceBusy && this.validation?.valid === true && this.validatedText === this.text;
  }
  /** Asks the server for the importance measures of the model on screen. The newest request wins; a table never outlives an edit. */
  async computeImportance(): Promise<void> {
    if (this.importanceBusy) return;
    this.importanceBusy = true; // before the first await, so a second press while the model is being checked is ignored
    this.emit();
    const mine = ++this.importanceSeq;
    const requestId = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.importanceRequestId = requestId;
    await this.settle();
    if (this.validation?.valid !== true) {
      this.importanceBusy = false;
      this.emit();
      return this.setNotice('warning', `Importance needs a valid model: ${this.errorCount} problem${this.errorCount === 1 ? '' : 's'} to fix first.`);
    }
    const text = this.text;
    const model_hash = this.validation.model_hash;
    try {
      const r = await this.api.importance(text, requestId);
      if (r.kind === 'dequeued' || (r.kind === 'failed' && r.why === 'cancelled')) this.setNotice('info', 'The importance table was cancelled. Nothing was changed.');
      else if (mine === this.importanceSeq) this.importanceData = { text, model_hash, response: r };
    } catch (e) {
      if (mine === this.importanceSeq) this.importanceData = { text, model_hash, response: { kind: 'failed', why: 'internal', message: `Could not compute the importance table: ${(e as Error).message}` } };
    } finally {
      if (mine === this.importanceSeq) {
        this.importanceBusy = false;
        this.importanceRequestId = null;
      }
      this.emit();
    }
  }

  // ---- figure ----
  /** True when the figure must not show the result: it is out of date, or an edit has not been checked yet so it may be. */
  get figureStale(): boolean {
    return this.stale || this.validatedText !== this.text;
  }
  /** The drawing as a standalone SVG document, with the result if there is one (labelled when it is out of date or not complete). */
  figureSvg(): string {
    return figureSvg(this.doc, { result: this.result?.kind === 'ran' ? { record: this.result.record, stale: this.figureStale, ...(this.result.cross ? { cross: this.result.cross } : {}) } : null }); // an edit not yet checked counts as out of date: the figure never pairs old numbers with a new drawing
  }

  // ---- import ----
  /**
   * Imports an Open-PSA file under `name` (the server keeps the original beside the model) and opens the result. A refusal is returned
   * with its errors and changes nothing: the model on the screen is untouched.
   */
  async importFile(text: string, name: string): Promise<ImportResponse | null> {
    let r: ImportResponse;
    try {
      r = await this.api.importModel(text, name);
    } catch (e) {
      this.setNotice('error', `Could not import: ${(e as Error).message}`);
      return null;
    }
    if (r.kind === 'imported') {
      await this.refreshModels();
      if (await this.open(r.name)) {
        const extra = r.notes.length ? ` ${r.notes.length} note${r.notes.length === 1 ? '' : 's'} about the import are in ${r.name}.opsa-import.log.` : '';
        this.setNotice('info', `Imported ${r.name}: ${r.summary.events} basic events, ${r.summary.gates} gates. The original file is kept as ${r.name}.opsa.xml.${extra}`);
      }
    }
    return r;
  }

  // ---- files ----
  setNotice(kind: Notice['kind'] | null, text = ''): void {
    this.notice = kind ? { kind, text } : null;
    this.emit();
  }
  newModel(): void {
    this.doc = D.newModel(undefined, this.now());
    this.lesson = null;
    this.calcShown = false;
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null;
    this.fileName = null;
    this.result = null;
    this.runError = null;
    this.savedText = this.text;
    this.afterChange();
  }
  async refreshModels(): Promise<void> {
    try {
      this.models = await this.api.listModels();
    } catch (e) {
      this.setNotice('error', `Could not list the saved models: ${(e as Error).message}`);
    }
    this.emit();
  }
  async open(name: string): Promise<boolean> {
    try {
      const doc = D.parseDoc(await this.api.loadModel(name));
      this.doc = doc;
      this.lesson = null;
      this.calcShown = false;
      this.undoStack = [];
      this.redoStack = [];
      this.selected = null;
      this.fileName = name;
      this.result = null;
      this.runError = null;
      this.savedText = this.text; // formatting differences are not unsaved work
      this.afterChange();
      this.setNotice('info', `Opened ${name}.`);
      return true;
    } catch (e) {
      this.setNotice('error', `Could not open ${name}: ${(e as Error).message}`);
      return false;
    }
  }
  /** Saves under the current name, or under `name` (Save As). Returns false when a name is needed. */
  async save(name?: string): Promise<boolean> {
    const target = name ?? this.fileName;
    if (!target) return false;
    try {
      const touched = D.touch(this.doc, this.now());
      const text = D.serialize(touched);
      await this.api.saveModel(target, text);
      this.doc = touched; // metadata only, not an undoable edit
      this.savedText = this.text;
      this.fileName = target;
      this.scheduleValidation();
      this.setNotice('info', `Saved ${target}.`);
      await this.refreshModels();
      return true;
    } catch (e) {
      this.setNotice('error', `Could not save: ${(e as Error).message}`);
      return false;
    }
  }
}
