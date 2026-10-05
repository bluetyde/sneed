// The editor's state and commands, with no DOM: what is selected, the undo history, validation, runs and what is stale.
// The UI only draws this and calls its methods, so everything here is testable without a browser.

import { ApiError, type Api, type Issue, type Method, type ModelInfo, type RunResponse, type RuntimeInfo, type ValidateResponse } from '../api.js';
import * as D from './doc.js';
import { buildVisual, type Visual } from './visual.js';

export interface Notice {
  kind: 'info' | 'warning' | 'error';
  text: string;
}

interface Snapshot {
  doc: D.Doc;
  label: string;
}

export interface EditorOptions {
  /** How long to wait after an edit before asking the server to validate. */
  debounceMs?: number;
  now?: () => string;
}

export class Editor {
  doc: D.Doc = D.newModel();
  selected: string | null = null;
  fileName: string | null = null;
  validation: ValidateResponse | null = null;
  runtime: RuntimeInfo | null = null;
  method: Method = 'exact';
  running = false;
  result: RunResponse | null = null;
  runError: string | null = null;
  /** Event ids of the cut set being explained, highlighted on the drawing. */
  highlight: string[] = [];
  notice: Notice | null = null;
  models: ModelInfo[] = [];

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
  /** Run needs a known-valid model, an installed runtime and no run in progress. */
  get canRun(): boolean {
    return !this.running && this.validation?.valid === true && this.runtime?.installed === true;
  }
  /** Why Run is unavailable, in words, or null when it is available. */
  get runBlockedReason(): string | null {
    if (this.running) return 'a run is in progress';
    if (this.runtime && !this.runtime.installed) return 'the SCRAM runtime is not installed: run `npm run runtime -- install`';
    if (!this.validation) return 'the model has not been checked yet';
    if (!this.validation.valid) return `${this.errorCount} problem${this.errorCount === 1 ? '' : 's'} to fix first`;
    return null;
  }
  /** True when the shown result is for an earlier version of the model or another method. */
  get stale(): boolean {
    if (this.result?.kind !== 'ran') return false;
    const r = this.result.record;
    return r.input_hashes.model_hash !== this.validation?.model_hash || r.method !== this.method;
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
    if (key === this.selected) return;
    this.selected = key;
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
    const label = (id: string): string => D.findEvent(this.doc, id)?.name ?? id;
    const names = events.map(label);
    if (names.length === 1) return `The top event occurs if ${names[0]} fails.`;
    if (names.length === 2) return `The top event occurs if ${names[0]} and ${names[1]} both fail.`;
    return `The top event occurs if ${names.slice(0, -1).join(', ')}, and ${names.at(-1)} all fail.`;
  }

  // ---- problems ----
  /** Selects the first node a problem names, so a click in the Problems list lands on the offender. */
  selectIssue(issue: Issue): void {
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
  async run(): Promise<void> {
    if (this.running) return;
    await this.settle(); // run exactly the text that was just checked
    const blocked = this.runBlockedReason;
    if (blocked) return this.setNotice('warning', `Run blocked: ${blocked}.`);
    this.running = true;
    this.runError = null;
    this.setNotice(null);
    this.emit();
    try {
      this.result = await this.api.run(this.text, this.method);
      this.highlight = [];
    } catch (e) {
      if (e instanceof ApiError && e.code === 'E_SETUP_REQUIRED') this.runtime = { installed: false, code: e.code, message: e.message };
      this.runError = e instanceof ApiError ? `${e.message} (${e.code})` : (e as Error).message;
    } finally {
      this.running = false;
      this.emit();
    }
  }
  async cancel(): Promise<void> {
    if (!this.running) return;
    await this.api.cancel().catch(() => undefined);
  }

  // ---- files ----
  setNotice(kind: Notice['kind'] | null, text = ''): void {
    this.notice = kind ? { kind, text } : null;
    this.emit();
  }
  newModel(): void {
    this.doc = D.newModel(undefined, this.now());
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
