// Lessons (docs/plans/04-lessons.md): data files, a loader that refuses an unchecked value, and a checker.
// The checker looks at structure and numbers in the student's model and never at where anything is drawn.
// Expected values are never computed here: each outcome must name an oracle entry and equal it, and a lesson
// is complete only when an engine result (completed, complete) also matches one of its outcomes.

export interface LessonDoc {
  top?: unknown;
  events?: unknown;
  gates?: unknown;
}
type GateType = 'and' | 'or' | 'atleast';
interface Ev { id: string; probability: number }
interface Gt { id: string; type: string; inputs: string[]; threshold?: number }

export type Check =
  | { kind: 'top-is-event' }
  /** `type` may list several gate types, for a step the student later revises (lesson 2 moves from AND to OR). */
  | { kind: 'top-gate'; type: GateType | GateType[] }
  | { kind: 'event-count'; count: number }
  /** The probabilities of all events, as a multiset (order does not matter). */
  | { kind: 'probabilities'; values: number[] }
  | { kind: 'shared-event'; minParents: number }
  /** The top gate is a voting gate with exactly this threshold over this many distinct basic events. */
  | { kind: 'vote'; threshold: number; inputs: number };

export type Detect =
  | { kind: 'percent-probability' }
  | { kind: 'single-input-gate' }
  | { kind: 'wrong-top-gate'; expected: GateType }
  | { kind: 'extra-events'; max: number }
  | { kind: 'unused-event' };

export interface Step { id: string; prompt: string; hint: string; check: Check }
export interface Mistake { id: string; message: string; detect: Detect }
export interface Outcome {
  id: string;
  label: string;
  /** Id of the entry in tests/oracles.json that fixes these numbers. */
  oracle: string;
  probability: number;
  cut_sets: string[][];
  tolerance: { absolute: number };
}
export interface Lesson {
  schema: { id: 'sneed.lesson'; version: 1 };
  id: string;
  title: string;
  goals: string[];
  /** Plain statement of what the numbers are and are not. */
  assumptions: string;
  start: LessonDoc | null;
  steps: Step[];
  outcomes: Outcome[];
  mistakes: Mistake[];
  /** Shown only after the student has tried. */
  hand_calculation: string[];
}

export interface OracleEntry { id: string; expected_probability: number; expected_cut_sets: string[][] }

export class LessonError extends Error {
  constructor(readonly code: 'L_SCHEMA' | 'L_NO_ORACLE' | 'L_ORACLE_MISMATCH', message: string) {
    super(message);
    this.name = 'LessonError';
  }
}

/** Largest tolerance a lesson may grade with. Wide enough for floating point, far too narrow to accept a wrong answer. */
export const MAX_TOLERANCE = 1e-9;

const GATE_TYPES = ['and', 'or', 'atleast'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const gateType = (v: unknown): boolean => typeof v === 'string' && GATE_TYPES.includes(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(str);

function validCheck(c: unknown): boolean {
  if (!isObj(c) || typeof c.kind !== 'string') return false;
  switch (c.kind) {
    case 'top-is-event':
      return true;
    case 'top-gate':
      return gateType(c.type) || (Array.isArray(c.type) && c.type.length > 0 && c.type.every(gateType));
    case 'event-count':
      return int(c.count, 1);
    case 'probabilities':
      return Array.isArray(c.values) && c.values.length > 0 && c.values.every((p) => num(p) && p >= 0 && p <= 1);
    case 'shared-event':
      return int(c.minParents, 2);
    case 'vote':
      return int(c.threshold, 1) && int(c.inputs, 2) && c.threshold <= c.inputs;
    default:
      return false;
  }
}

function validDetect(d: unknown): boolean {
  if (!isObj(d) || typeof d.kind !== 'string') return false;
  switch (d.kind) {
    case 'percent-probability':
    case 'single-input-gate':
    case 'unused-event':
      return true;
    case 'wrong-top-gate':
      return gateType(d.expected) && typeof d.expected === 'string';
    case 'extra-events':
      return int(d.max, 1);
    default:
      return false;
  }
}

const sortSets = (c: string[][]): string => JSON.stringify(c.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join().localeCompare(b.join())));

/** Parse and validate a lesson file. Refuses a lesson whose outcome is missing from, or differs from, the oracle. */
export function loadLesson(text: string, oracles: OracleEntry[]): Lesson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LessonError('L_SCHEMA', 'lesson is not valid JSON');
  }
  const bad = (msg: string): never => {
    throw new LessonError('L_SCHEMA', msg);
  };
  if (!isObj(raw)) return bad('lesson must be an object');
  const l = raw;
  if (!isObj(l.schema) || l.schema.id !== 'sneed.lesson' || l.schema.version !== 1) bad('schema must be sneed.lesson version 1');
  for (const k of ['id', 'title', 'assumptions'] as const) if (!str(l[k])) bad(`${k} must be a non-empty string`);
  for (const k of ['goals', 'hand_calculation'] as const) if (!strings(l[k])) bad(`${k} must be a non-empty list of strings`);
  if (l.start !== null && !isObj(l.start)) bad('start must be a model or null');
  if (!Array.isArray(l.steps) || l.steps.length === 0) bad('steps must be a non-empty list');
  for (const s of l.steps as unknown[]) {
    if (!isObj(s) || !str(s.id) || !str(s.prompt) || !str(s.hint) || !validCheck(s.check)) bad('each step needs id, prompt, hint and a well-formed known check');
  }
  if (!Array.isArray(l.mistakes)) bad('mistakes must be a list');
  for (const m of l.mistakes as unknown[]) {
    if (!isObj(m) || !str(m.id) || !str(m.message) || !validDetect(m.detect)) bad('each mistake needs id, message and a well-formed known detector');
  }
  if (!Array.isArray(l.outcomes) || l.outcomes.length === 0) bad('outcomes must be a non-empty list');
  const byId = new Map(oracles.map((o) => [o.id, o]));
  for (const o of l.outcomes as unknown[]) {
    if (!isObj(o) || !str(o.id) || !str(o.label) || !str(o.oracle) || !num(o.probability) || o.probability < 0 || o.probability > 1) {
      bad('each outcome needs id, label, oracle and a probability between 0 and 1');
    }
    const out = o as unknown as Record<string, unknown>;
    if (!Array.isArray(out.cut_sets) || out.cut_sets.length === 0 || !out.cut_sets.every(strings)) bad('outcome cut_sets must be a non-empty list of non-empty lists of ids');
    if (!isObj(out.tolerance) || !num(out.tolerance.absolute) || out.tolerance.absolute < 0 || out.tolerance.absolute > MAX_TOLERANCE) {
      bad(`outcome tolerance.absolute must be a finite number from 0 to ${MAX_TOLERANCE}`);
    }
    const typed = out as unknown as Outcome;
    const ref = byId.get(typed.oracle);
    if (!ref) throw new LessonError('L_NO_ORACLE', `outcome ${JSON.stringify(typed.id)} names oracle ${JSON.stringify(typed.oracle)}, which does not exist`);
    if (Math.abs(ref.expected_probability - typed.probability) > 1e-12 || sortSets(ref.expected_cut_sets) !== sortSets(typed.cut_sets)) {
      throw new LessonError('L_ORACLE_MISMATCH', `outcome ${JSON.stringify(typed.id)} does not equal oracle ${JSON.stringify(typed.oracle)}`);
    }
  }
  return l as unknown as Lesson;
}

interface Parts { top: string; events: Ev[]; gates: Gt[]; malformed: boolean }

/** Read a student's document without coercing anything: an entry of the wrong shape is skipped and marks the document malformed. */
function parts(doc: unknown): Parts {
  const d: Record<string, unknown> = isObj(doc) ? doc : {};
  let malformed = !isObj(doc);
  const events: Ev[] = [];
  if (Array.isArray(d.events)) {
    for (const e of d.events) {
      if (isObj(e) && str(e.id) && num(e.probability)) events.push({ id: e.id, probability: e.probability });
      else malformed = true;
    }
  } else malformed = true;
  const gates: Gt[] = [];
  if (Array.isArray(d.gates)) {
    for (const g of d.gates) {
      if (isObj(g) && str(g.id) && str(g.type) && Array.isArray(g.inputs) && g.inputs.every(str)) {
        gates.push({ id: g.id, type: g.type, inputs: g.inputs as string[], ...(num(g.threshold) ? { threshold: g.threshold } : {}) });
      } else malformed = true;
    }
  } else malformed = true;
  if (!str(d.top)) malformed = true;
  return { top: typeof d.top === 'string' ? d.top : '', events, gates, malformed };
}

/** For each basic event, how many distinct gates use it. Gate ids are not events and are never counted. */
function parentCounts(p: Parts): Map<string, number> {
  const isEvent = new Set(p.events.map((e) => e.id));
  const n = new Map<string, number>();
  for (const g of p.gates) for (const i of new Set(g.inputs)) if (isEvent.has(i)) n.set(i, (n.get(i) ?? 0) + 1);
  return n;
}

const sameMultiset = (a: number[], b: number[]): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort((m, n) => m - n);
  const y = [...b].sort((m, n) => m - n);
  return x.every((v, i) => Math.abs(v - y[i]!) <= 1e-12);
};

export function runCheck(c: Check, doc: LessonDoc): boolean {
  const p = parts(doc);
  if (p.malformed) return false;
  const topGate = p.gates.find((g) => g.id === p.top);
  switch (c.kind) {
    case 'top-is-event':
      return p.events.some((e) => e.id === p.top);
    case 'top-gate':
      return topGate !== undefined && (Array.isArray(c.type) ? c.type : [c.type]).includes(topGate.type as GateType);
    case 'event-count':
      return p.events.length === c.count;
    case 'probabilities':
      return sameMultiset(p.events.map((e) => e.probability), c.values);
    case 'shared-event':
      return [...parentCounts(p).values()].some((n) => n >= c.minParents);
    case 'vote': {
      if (topGate?.type !== 'atleast' || topGate.threshold !== c.threshold) return false;
      const events = new Set(p.events.map((e) => e.id));
      const distinct = new Set(topGate.inputs);
      return distinct.size === topGate.inputs.length && distinct.size === c.inputs && [...distinct].every((i) => events.has(i));
    }
  }
}

export function runDetect(d: Detect, doc: LessonDoc): boolean {
  const p = parts(doc);
  switch (d.kind) {
    case 'percent-probability':
      // The validator rejects these as E_PROB_RANGE; the lesson explains why in student terms.
      return p.events.some((e) => e.probability > 1 && e.probability <= 100);
    case 'single-input-gate':
      return p.gates.some((g) => g.type !== 'atleast' && new Set(g.inputs).size === 1);
    case 'wrong-top-gate': {
      const t = p.gates.find((g) => g.id === p.top);
      return t !== undefined && t.type !== d.expected;
    }
    case 'extra-events':
      return p.events.length > d.max;
    case 'unused-event': {
      const used = new Set(p.gates.flatMap((g) => g.inputs));
      return p.events.some((e) => e.id !== p.top && !used.has(e.id));
    }
  }
}

export interface EngineResult { probability: number; cutSets: string[][] }

export interface LessonProgress {
  steps: { id: string; done: boolean }[];
  mistakes: { id: string; message: string }[];
  /** The document has an entry of the wrong shape; nothing is credited. */
  malformed: boolean;
  /** The lesson outcome the engine result matched, if a result was given. */
  outcome: string | null;
  /** Every step done, no mistake, and the engine result equals one of the lesson's expected outcomes. */
  complete: boolean;
}

export function checkLesson(lesson: Lesson, doc: LessonDoc, result?: EngineResult): LessonProgress {
  const steps = lesson.steps.map((s) => ({ id: s.id, done: runCheck(s.check, doc) }));
  const mistakes = lesson.mistakes.filter((m) => runDetect(m.detect, doc)).map((m) => ({ id: m.id, message: m.message }));
  const malformed = parts(doc).malformed;
  const matched = result ? matchOutcome(lesson, result.probability, result.cutSets) : null;
  return { steps, mistakes, malformed, outcome: matched?.id ?? null, complete: !malformed && steps.every((s) => s.done) && mistakes.length === 0 && matched !== null };
}

/** Compare an engine result with a lesson outcome. The caller has already required a completed, complete result. */
export function matchOutcome(lesson: Lesson, probability: number, cutSets: string[][]): Outcome | null {
  return lesson.outcomes.find((o) => Math.abs(o.probability - probability) <= o.tolerance.absolute && sortSets(o.cut_sets) === sortSets(cutSets)) ?? null;
}
