// Event-tree lessons (docs/plans/04-lessons.md and 13-event-trees.md, stage S5): the lesson file format, a shape validator, the checks of a
// student's event tree, and the comparison of an analysis with the expected outcome. Pure code, shared by the browser and the server loader.
// Like the fault-tree lessons: the checker looks at structure and numbers of the student's document and never at anything drawn; every
// expected number is the number of an ORACLE entry (tests/event-tree-oracles.json), which the server loader requires the lesson to equal and
// which a test re-derives independently by exact enumeration; a lesson is complete only when a complete, current analysis matches an outcome.
// Expected values are never computed here. (The "independence check" below is an explanation computed from the student's own result, never a
// grade.)
import type { Branch, PathStep } from './event-tree-paths.js';

export interface EtLessonDoc {
  initiating_event?: unknown;
  headings?: unknown;
  end_states?: unknown;
  sequences?: unknown;
}

export type EtCheck =
  | { kind: 'frequency'; value: number }
  /** The events the headings fail on, in order. Names and ids of the headings are the student's own. */
  | { kind: 'heading-events'; events: string[] }
  | { kind: 'sequence-count'; count: number }
  | { kind: 'end-states-min'; count: number }
  /** Every sequence has an end state that exists. */
  | { kind: 'ends-assigned' }
  /** Sequences are grouped by how many headings failed on their path: each group shares one end state, and the groups use different ones. */
  | { kind: 'ends-by-failures' }
  /** The heading failing on `heading_event` is asked only if the heading failing on `only_if_event` took `branch`. */
  | { kind: 'bypass'; heading_event: string; only_if_event: string; branch: Branch }
  /** The student has typed a prediction (a number) in the lesson panel. */
  | { kind: 'prediction' };

export type EtDetect =
  | { kind: 'same-event-twice' }
  | { kind: 'heading-on-event'; event: string }
  | { kind: 'frequency-zero' }
  | { kind: 'bypass-other-branch'; heading_event: string; only_if_event: string; expected: Branch };

export interface EtStep { id: string; prompt: string; hint: string; check: EtCheck }
export interface EtMistake { id: string; message: string; detect: EtDetect }
export interface EtOutcome {
  id: string;
  label: string;
  /** Id of the entry in tests/event-tree-oracles.json that fixes these numbers. */
  oracle: string;
  /** The frequency of each sequence, keyed by the EVENTS on its path ("X:works,Y:fails"), so a student's own heading names and ids do not matter. */
  frequencies: { key: string; frequency: number }[];
  tolerance: { absolute: number };
}
export interface EtLesson {
  schema: { id: 'sneed.event-tree-lesson'; version: 1 };
  id: string;
  title: string;
  goals: string[];
  assumptions: string;
  /** The fault-tree model the lesson saves under this name when it starts: the headings refer to its events and gates. */
  model: { name: string; document: Record<string, unknown> };
  /** Optional: ask for a number before the analysis, and show it next to the result. */
  prediction?: { prompt: string; sequence: { event: string; branch: Branch }[] };
  steps: EtStep[];
  outcomes: EtOutcome[];
  mistakes: EtMistake[];
  hand_calculation: string[];
  /** For the instructor: a question and a model answer each. Never shown to the student. */
  discussion: { question: string; answer: string }[];
}

/** What the browser gets: the lesson without the instructor's questions and answers, which are never sent to it. */
export type EtStudentLesson = Omit<EtLesson, 'discussion'>;

export class EtLessonError extends Error {
  constructor(readonly code: 'L_SCHEMA' | 'L_NO_ORACLE' | 'L_ORACLE_MISMATCH' | 'L_BAD_MODEL', message: string) {
    super(message);
    this.name = 'EtLessonError';
  }
}

/** An entry of tests/event-tree-oracles.json, as far as the loader needs it. */
export interface EtOracleEntry {
  id: string;
  model: { top: string; events: { id: string; probability: number }[]; gates: { id: string; type: string; inputs: string[] }[] };
  initiating_frequency: number;
  headings: { event: string; asked_only_if?: { event: string; branch: Branch } }[];
  sequences: { path: { event: string; branch: Branch }[]; probability: number; frequency: number }[];
}

/** Largest tolerance a lesson may grade with: wide enough for floating point, far too narrow to accept a wrong answer. */
export const MAX_ET_TOLERANCE = 1e-9;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(str);
const branch = (v: unknown): v is Branch => v === 'works' || v === 'fails';

function validCheck(c: unknown): boolean {
  if (!isObj(c) || typeof c.kind !== 'string') return false;
  switch (c.kind) {
    case 'frequency':
      return num(c.value) && c.value >= 0;
    case 'heading-events':
      return strings(c.events);
    case 'sequence-count':
    case 'end-states-min':
      return int(c.count, 1);
    case 'ends-assigned':
    case 'ends-by-failures':
    case 'prediction':
      return true;
    case 'bypass':
      return str(c.heading_event) && str(c.only_if_event) && c.heading_event !== c.only_if_event && branch(c.branch);
    default:
      return false;
  }
}

function validDetect(d: unknown): boolean {
  if (!isObj(d) || typeof d.kind !== 'string') return false;
  switch (d.kind) {
    case 'same-event-twice':
    case 'frequency-zero':
      return true;
    case 'heading-on-event':
      return str(d.event);
    case 'bypass-other-branch':
      return str(d.heading_event) && str(d.only_if_event) && branch(d.expected);
    default:
      return false;
  }
}

/** The key of a path in terms of its events: "X:works,Y:fails". */
export const eventKey = (path: { event: string; branch: string }[]): string => path.map((s) => `${s.event}:${s.branch}`).join(',');

/** Parses and shape-checks a lesson file. The server loader adds the checks that need files (the oracle, the model). */
export function parseEtLesson(text: string): EtLesson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EtLessonError('L_SCHEMA', 'lesson is not valid JSON');
  }
  const bad = (msg: string): never => {
    throw new EtLessonError('L_SCHEMA', msg);
  };
  if (!isObj(raw)) return bad('lesson must be an object');
  const l = raw;
  if (!isObj(l.schema) || l.schema.id !== 'sneed.event-tree-lesson' || l.schema.version !== 1) bad('schema must be sneed.event-tree-lesson version 1');
  for (const k of ['id', 'title', 'assumptions'] as const) if (!str(l[k])) bad(`${k} must be a non-empty string`);
  for (const k of ['goals', 'hand_calculation'] as const) if (!strings(l[k])) bad(`${k} must be a non-empty list of strings`);
  if (!isObj(l.model) || !str(l.model.name) || !isObj(l.model.document)) bad('model needs a name and a document');
  if (!Array.isArray(l.steps) || l.steps.length === 0) bad('steps must be a non-empty list');
  for (const s of l.steps as unknown[]) if (!isObj(s) || !str(s.id) || !str(s.prompt) || !str(s.hint) || !validCheck(s.check)) bad('each step needs id, prompt, hint and a well-formed known check');
  if (!Array.isArray(l.mistakes)) bad('mistakes must be a list');
  for (const m of l.mistakes as unknown[]) if (!isObj(m) || !str(m.id) || !str(m.message) || !validDetect(m.detect)) bad('each mistake needs id, message and a well-formed known detector');
  if (!Array.isArray(l.outcomes) || l.outcomes.length === 0) bad('outcomes must be a non-empty list');
  for (const o of l.outcomes as unknown[]) {
    if (!isObj(o) || !str(o.id) || !str(o.label) || !str(o.oracle)) return bad('each outcome needs id, label and oracle');
    if (!Array.isArray(o.frequencies) || o.frequencies.length === 0 || !o.frequencies.every((f) => isObj(f) && str(f.key) && num(f.frequency) && f.frequency >= 0)) bad('outcome frequencies must be a non-empty list of key and frequency');
    const listed = o.frequencies as { key: string }[];
    if (new Set(listed.map((f) => f.key)).size !== listed.length) bad('outcome frequencies name a sequence twice');
    if (!isObj(o.tolerance) || !num(o.tolerance.absolute) || o.tolerance.absolute < 0 || o.tolerance.absolute > MAX_ET_TOLERANCE) bad(`outcome tolerance.absolute must be a finite number from 0 to ${MAX_ET_TOLERANCE}`);
  }
  if (l.prediction !== undefined) {
    const p = l.prediction;
    // the reveal multiplies the probabilities that the named headings FAIL, so a prediction is about a sequence in which they all do
    if (!isObj(p) || !str(p.prompt) || !Array.isArray(p.sequence) || p.sequence.length < 2 || !p.sequence.every((s) => isObj(s) && str(s.event) && s.branch === 'fails')) bad('prediction needs a prompt and a sequence of at least two events that all fail');
  }
  if (!Array.isArray(l.discussion) || !l.discussion.every((d) => isObj(d) && str(d.question) && str(d.answer))) bad('discussion must be a list of question and answer');
  return l as unknown as EtLesson;
}

/** Whether an outcome's numbers equal the oracle entry's, to the lesson's own tolerance and exactly in which sequences exist. */
export function outcomeEqualsOracle(o: EtOutcome, ref: EtOracleEntry): boolean {
  const want = new Map(ref.sequences.map((s) => [eventKey(s.path), s.frequency]));
  if (want.size !== o.frequencies.length || new Set(o.frequencies.map((f) => f.key)).size !== o.frequencies.length) return false;
  return o.frequencies.every((f) => {
    const w = want.get(f.key);
    return w !== undefined && Math.abs(w - f.frequency) <= 1e-12;
  });
}

/**
 * Everything about a lesson that must agree with its oracle entries, as the first reason it does not (or null): each outcome equals the entry
 * it names, the model the lesson saves is the model the entry describes, and the steps that name a frequency, headings, a bypass or a
 * prediction name exactly what the entry has. A lesson whose steps ask for something other than what its numbers were derived for would
 * grade a student against the wrong answer.
 */
export function lessonAgainstOracles(lesson: EtLesson, oracles: EtOracleEntry[]): { code: 'L_NO_ORACLE' | 'L_ORACLE_MISMATCH' | 'L_BAD_MODEL'; message: string } | null {
  const byId = new Map(oracles.map((o) => [o.id, o]));
  const doc = lesson.model.document as { top?: unknown; events?: unknown; gates?: unknown };
  const events = Array.isArray(doc.events) ? (doc.events as { id?: unknown; probability?: unknown }[]) : [];
  const gates = Array.isArray(doc.gates) ? (doc.gates as { id?: unknown; type?: unknown; inputs?: unknown }[]) : [];
  for (const o of lesson.outcomes) {
    const ref = byId.get(o.oracle);
    if (!ref) return { code: 'L_NO_ORACLE', message: `outcome ${JSON.stringify(o.id)} names oracle ${JSON.stringify(o.oracle)}, which does not exist` };
    if (!outcomeEqualsOracle(o, ref)) return { code: 'L_ORACLE_MISMATCH', message: `outcome ${JSON.stringify(o.id)} does not equal oracle ${JSON.stringify(o.oracle)}` };
    const sameEvents = ref.model.events.length === events.length && ref.model.events.every((e) => events.some((x) => x.id === e.id && x.probability === e.probability));
    const sameGates = ref.model.gates.length === gates.length && ref.model.gates.every((g) => gates.some((x) => x.id === g.id && x.type === g.type && Array.isArray(x.inputs) && [...x.inputs].sort().join() === [...g.inputs].sort().join()));
    if (doc.top !== ref.model.top || !sameEvents || !sameGates) return { code: 'L_BAD_MODEL', message: `the model of the lesson is not the model of oracle ${JSON.stringify(o.oracle)}` };
    for (const s of lesson.steps) {
      const c = s.check;
      const bad = (what: string): { code: 'L_ORACLE_MISMATCH'; message: string } => ({ code: 'L_ORACLE_MISMATCH', message: `step ${JSON.stringify(s.id)} asks for ${what} that differs from oracle ${JSON.stringify(o.oracle)}` });
      if (c.kind === 'frequency' && Math.abs(c.value - ref.initiating_frequency) > 1e-12) return bad('a frequency');
      if (c.kind === 'heading-events' && c.events.join() !== ref.headings.map((h) => h.event).join()) return bad('headings');
      if (c.kind === 'sequence-count' && c.count !== ref.sequences.length) return bad('a number of sequences');
      if (c.kind === 'bypass' && !ref.headings.some((h) => h.event === c.heading_event && h.asked_only_if?.event === c.only_if_event && h.asked_only_if.branch === c.branch)) return bad('a bypass');
    }
    if (lesson.prediction && !ref.sequences.some((s) => eventKey(s.path) === eventKey(lesson.prediction!.sequence))) return { code: 'L_ORACLE_MISMATCH', message: `the prediction of the lesson names a sequence that oracle ${JSON.stringify(o.oracle)} does not have` };
  }
  return null;
}

// ---------------------------------------------------------------- reading the student's document

interface Head { id: string; event: string; ask?: { heading: string; branch: string } }
interface Parts { frequency: number | null; heads: Head[]; endIds: Set<string>; seqEnds: string[]; /** For each sequence, how many headings failed on its path. */ seqFails: number[]; malformed: boolean }

/** Reads the student's document without coercing anything: an entry of the wrong shape is skipped and marks the document malformed. */
function parts(doc: unknown): Parts {
  const d: Record<string, unknown> = isObj(doc) ? doc : {};
  let malformed = !isObj(doc);
  const ie = isObj(d.initiating_event) ? d.initiating_event : null;
  const frequency = ie && num(ie.frequency) ? ie.frequency : null;
  if (frequency === null) malformed = true;
  const heads: Head[] = [];
  if (Array.isArray(d.headings)) {
    for (const h of d.headings) {
      if (isObj(h) && str(h.id) && str(h.event)) {
        const a = isObj(h.asked_only_if) && str(h.asked_only_if.heading) && str(h.asked_only_if.branch) ? { heading: h.asked_only_if.heading, branch: h.asked_only_if.branch } : undefined;
        heads.push({ id: h.id, event: h.event, ...(a ? { ask: a } : {}) });
      } else malformed = true;
    }
  } else malformed = true;
  const endIds = new Set<string>();
  if (Array.isArray(d.end_states)) for (const e of d.end_states) (isObj(e) && str(e.id) ? endIds.add(e.id) : (malformed = true));
  else malformed = true;
  const seqEnds: string[] = [];
  const seqFails: number[] = [];
  if (Array.isArray(d.sequences)) {
    for (const s of d.sequences) {
      if (isObj(s) && typeof s.end_state === 'string' && Array.isArray(s.path)) {
        seqEnds.push(s.end_state);
        seqFails.push(s.path.filter((st) => isObj(st) && st.branch === 'fails').length);
      } else malformed = true;
    }
  } else malformed = true;
  return { frequency, heads, endIds, seqEnds, seqFails, malformed };
}

export function runEtCheck(c: EtCheck, doc: EtLessonDoc, ctx: { prediction: number | null } = { prediction: null }): boolean {
  const p = parts(doc);
  if (p.malformed) return false;
  switch (c.kind) {
    case 'frequency':
      return p.frequency !== null && Math.abs(p.frequency - c.value) <= 1e-12;
    case 'heading-events':
      return p.heads.length === c.events.length && p.heads.every((h, i) => h.event === c.events[i]);
    case 'sequence-count':
      return p.seqEnds.length === c.count;
    case 'end-states-min':
      return p.endIds.size >= c.count;
    case 'ends-assigned':
      return p.seqEnds.length > 0 && p.seqEnds.every((e) => e !== '' && p.endIds.has(e));
    case 'bypass': {
      const h = p.heads.find((x) => x.event === c.heading_event);
      const on = h?.ask ? p.heads.find((x) => x.id === h.ask!.heading) : undefined;
      return h !== undefined && on !== undefined && on.event === c.only_if_event && h.ask!.branch === c.branch;
    }
    case 'ends-by-failures': {
      if (p.seqEnds.length === 0 || p.seqEnds.some((e) => e === '' || !p.endIds.has(e))) return false;
      const byCount = new Map<number, Set<string>>();
      p.seqFails.forEach((n, i) => byCount.set(n, (byCount.get(n) ?? new Set<string>()).add(p.seqEnds[i]!)));
      const states = [...byCount.values()];
      return states.every((g) => g.size === 1) && new Set(states.map((g) => [...g][0])).size === states.length;
    }
    case 'prediction':
      return ctx.prediction !== null;
    default:
      return false; // a kind this version does not know (the loader refuses such a lesson; this is for a hand-built one)
  }
}

export function runEtDetect(d: EtDetect, doc: EtLessonDoc): boolean {
  const p = parts(doc);
  switch (d.kind) {
    case 'same-event-twice':
      return new Set(p.heads.map((h) => h.event)).size < p.heads.length;
    case 'heading-on-event':
      return p.heads.some((h) => h.event === d.event);
    case 'frequency-zero':
      return p.frequency === 0;
    case 'bypass-other-branch': {
      const h = p.heads.find((x) => x.event === d.heading_event);
      const on = h?.ask ? p.heads.find((x) => x.id === h.ask!.heading) : undefined;
      return h !== undefined && on !== undefined && on.event === d.only_if_event && h.ask!.branch !== d.expected;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------- the analysis against the outcome

/** What the lesson needs of an event-tree result record. */
export interface EtRecordLike {
  /** The hash of the fault-tree model the analysis used: the lesson is complete only for the lesson's own model. */
  input_hashes?: { model_hash?: string };
  headings: { id: string; event: string }[];
  sequences: { key: string; path: PathStep[]; probability: number; frequency: number }[];
}

/** The frequency of each sequence of an analysis, keyed by the events on its path. Null when two headings share an event (the key would be ambiguous). */
export function frequenciesByEvent(rec: EtRecordLike): Map<string, number> | null {
  const eventOf = new Map(rec.headings.map((h) => [h.id, h.event]));
  if (new Set(eventOf.values()).size !== eventOf.size) return null;
  const out = new Map<string, number>();
  for (const s of rec.sequences) {
    const k = eventKey(s.path.map((st) => ({ event: eventOf.get(st.heading) ?? `?${st.heading}`, branch: st.branch })));
    if (out.has(k)) return null;
    out.set(k, s.frequency);
  }
  return out;
}

/** The outcome an analysis matches: the same set of sequences, each frequency within the outcome's tolerance. */
export function matchEtOutcome(lesson: EtStudentLesson, rec: EtRecordLike): EtOutcome | null {
  const got = frequenciesByEvent(rec);
  if (!got) return null;
  return (
    lesson.outcomes.find((o) => new Set(o.frequencies.map((f) => f.key)).size === got.size && o.frequencies.length === got.size && o.frequencies.every((f) => { const g = got.get(f.key); return g !== undefined && Math.abs(g - f.frequency) <= o.tolerance.absolute; })) ?? null
  );
}

export interface EtLessonProgress {
  steps: { id: string; done: boolean }[];
  mistakes: { id: string; message: string }[];
  malformed: boolean;
  /** There is an analysis on show, and it was made with a fault-tree model other than the lesson's (so it cannot complete the lesson). */
  modelMismatch: boolean;
  outcome: string | null;
  complete: boolean;
}

/** What the lesson needs to know besides the document and the analysis. */
export interface EtLessonContext {
  /** What is typed in the prediction box now (shown as progress on the prediction step). */
  prediction: number | null;
  /** The prediction that was typed when the analysis on show was started. A lesson that asks for a prediction is complete only with one. */
  predictionAtResult?: number | null;
  /** The hash of the lesson's own fault-tree model. Without it a lesson cannot be complete: an unrelated model that gives the same numbers must not count. */
  modelHash?: string | null;
}

export function checkEtLesson(lesson: EtStudentLesson, doc: EtLessonDoc, record: EtRecordLike | null, ctx: EtLessonContext = { prediction: null }): EtLessonProgress {
  const steps = lesson.steps.map((s) => ({ id: s.id, done: runEtCheck(s.check, doc, ctx) }));
  const mistakes = lesson.mistakes.filter((m) => runEtDetect(m.detect, doc)).map((m) => ({ id: m.id, message: m.message }));
  const malformed = parts(doc).malformed;
  const matched = record ? matchEtOutcome(lesson, record) : null;
  const modelOk = !!ctx.modelHash && record?.input_hashes?.model_hash === ctx.modelHash;
  const predictionOk = !lesson.prediction || (ctx.predictionAtResult !== undefined && ctx.predictionAtResult !== null);
  return {
    steps, mistakes, malformed, modelMismatch: record !== null && !modelOk, outcome: matched?.id ?? null,
    complete: !malformed && steps.every((s) => s.done) && mistakes.length === 0 && matched !== null && modelOk && predictionOk,
  };
}

// ---------------------------------------------------------------- the reveal after a prediction

export interface PredictionReveal {
  predicted: number;
  /** The frequency of the asked-for sequence in the student's own analysis. */
  exact: number;
  /** What multiplying the two failure probabilities would give, times the initiating-event frequency: right only for independent headings. */
  product: number;
  /** (exact - product) / exact: how far below the exact value the product is. */
  productBelow: number;
  /** exact / product. */
  ratio: number;
  /** The two failure probabilities, from the analysis itself. */
  failureProbabilities: number[];
}

/**
 * Explains the prediction with numbers from the student's own result: the probability that each named heading fails (summed over the paths on
 * which it fails), their product times the initiating-event frequency, and the exact frequency of the sequence. Null when the sequence is not
 * in the analysis, or when a named heading is not asked on every path (then the failure probability is not a sum over all paths).
 */
export function predictionReveal(lesson: EtStudentLesson, rec: EtRecordLike, frequency: number, predicted: number): PredictionReveal | null {
  const p = lesson.prediction;
  if (!p) return null;
  const eventOf = new Map(rec.headings.map((h) => [h.id, h.event]));
  const byKey = new Map<string, { probability: number; frequency: number }>();
  const marginals = new Map<string, number>();
  for (const s of rec.sequences) {
    const steps = s.path.map((st) => ({ event: eventOf.get(st.heading) ?? '?', branch: st.branch }));
    byKey.set(eventKey(steps), s);
    for (const ev of p.sequence.map((x) => x.event)) {
      const step = steps.find((x) => x.event === ev);
      if (!step) return null; // not asked on this path
      if (step.branch === 'fails') marginals.set(ev, (marginals.get(ev) ?? 0) + s.probability);
    }
  }
  const asked = byKey.get(eventKey(p.sequence));
  if (!asked || asked.frequency <= 0) return null;
  const probs = p.sequence.map((x) => marginals.get(x.event) ?? 0);
  const product = probs.reduce((a, b) => a * b, 1) * frequency;
  return { predicted, exact: asked.frequency, product, productBelow: (asked.frequency - product) / asked.frequency, ratio: product > 0 ? asked.frequency / product : Number.POSITIVE_INFINITY, failureProbabilities: probs };
}

