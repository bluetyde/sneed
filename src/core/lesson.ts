// Lessons (docs/plans/04-lessons.md): data files, a loader that refuses an unchecked value, and a checker.
// The checker looks at structure and numbers in the student's model and never at where anything is drawn.
// Expected values are never computed here: each outcome must name an oracle entry and equal it.

export interface LessonDoc {
  top?: unknown;
  events?: unknown;
  gates?: unknown;
}
type GateType = 'and' | 'or' | 'atleast';
interface Ev { id: string; probability: number }
interface Gt { id: string; type: string; inputs: string[] }

export type Check =
  | { kind: 'top-is-event' }
  /** `type` may list several gate types, for a step the student later revises (lesson 2 moves from AND to OR). */
  | { kind: 'top-gate'; type: GateType | GateType[] }
  | { kind: 'event-count'; count: number }
  | { kind: 'has-probability'; value: number }
  | { kind: 'shared-event'; minParents: number };

export type Detect =
  | { kind: 'percent-probability' }
  | { kind: 'single-input-gate' }
  | { kind: 'wrong-top-gate'; expected: 'and' | 'or' | 'atleast' }
  | { kind: 'no-shared-event' }
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

const CHECKS = new Set(['top-is-event', 'top-gate', 'event-count', 'has-probability', 'shared-event']);
const DETECTS = new Set(['percent-probability', 'single-input-gate', 'wrong-top-gate', 'no-shared-event', 'unused-event']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

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
  for (const k of ['goals', 'hand_calculation'] as const) {
    const v = l[k];
    if (!Array.isArray(v) || v.length === 0 || !v.every(str)) bad(`${k} must be a non-empty list of strings`);
  }
  if (l.start !== null && !isObj(l.start)) bad('start must be a model or null');
  if (!Array.isArray(l.steps) || l.steps.length === 0) bad('steps must be a non-empty list');
  for (const s of l.steps as unknown[]) {
    if (!isObj(s) || !str(s.id) || !str(s.prompt) || !str(s.hint) || !isObj(s.check) || !CHECKS.has(String(s.check.kind))) bad('each step needs id, prompt, hint and a known check');
  }
  if (!Array.isArray(l.mistakes)) bad('mistakes must be a list');
  for (const m of l.mistakes as unknown[]) {
    if (!isObj(m) || !str(m.id) || !str(m.message) || !isObj(m.detect) || !DETECTS.has(String(m.detect.kind))) bad('each mistake needs id, message and a known detector');
  }
  if (!Array.isArray(l.outcomes) || l.outcomes.length === 0) bad('outcomes must be a non-empty list');
  const byId = new Map(oracles.map((o) => [o.id, o]));
  for (const o of l.outcomes as unknown[]) {
    if (!isObj(o) || !str(o.id) || !str(o.label) || !str(o.oracle) || typeof o.probability !== 'number' || !Array.isArray(o.cut_sets) || !isObj(o.tolerance) || typeof o.tolerance.absolute !== 'number') {
      bad('each outcome needs id, label, oracle, probability, cut_sets and tolerance.absolute');
    }
    const out = o as unknown as Outcome;
    const ref = byId.get(out.oracle);
    if (!ref) throw new LessonError('L_NO_ORACLE', `outcome ${JSON.stringify(out.id)} names oracle ${JSON.stringify(out.oracle)}, which does not exist`);
    const norm = (c: string[][]): string => JSON.stringify(c.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join().localeCompare(b.join())));
    if (Math.abs(ref.expected_probability - out.probability) > 1e-12 || norm(ref.expected_cut_sets) !== norm(out.cut_sets)) {
      throw new LessonError('L_ORACLE_MISMATCH', `outcome ${JSON.stringify(out.id)} does not equal oracle ${JSON.stringify(out.oracle)}`);
    }
  }
  return l as unknown as Lesson;
}

function parts(doc: LessonDoc): { top: string; events: Ev[]; gates: Gt[] } {
  const events = Array.isArray(doc.events) ? (doc.events as unknown[]).filter(isObj).map((e) => ({ id: String(e.id), probability: Number(e.probability) })) : [];
  const gates = Array.isArray(doc.gates)
    ? (doc.gates as unknown[]).filter(isObj).map((g) => ({ id: String(g.id), type: String(g.type), inputs: Array.isArray(g.inputs) ? g.inputs.map(String) : [] }))
    : [];
  return { top: typeof doc.top === 'string' ? doc.top : '', events, gates };
}

function parentCounts(gates: Gt[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const g of gates) for (const i of new Set(g.inputs)) n.set(i, (n.get(i) ?? 0) + 1);
  return n;
}

export function runCheck(c: Check, doc: LessonDoc): boolean {
  const { top, events, gates } = parts(doc);
  const topGate = gates.find((g) => g.id === top);
  switch (c.kind) {
    case 'top-is-event':
      return events.some((e) => e.id === top);
    case 'top-gate':
      return topGate !== undefined && (Array.isArray(c.type) ? c.type : [c.type]).includes(topGate.type as GateType);
    case 'event-count':
      return events.length === c.count;
    case 'has-probability':
      return events.some((e) => Math.abs(e.probability - c.value) <= 1e-12);
    case 'shared-event': {
      const counts = parentCounts(gates);
      return events.some((e) => (counts.get(e.id) ?? 0) >= c.minParents);
    }
  }
}

export function runDetect(d: Detect, doc: LessonDoc): boolean {
  const { top, events, gates } = parts(doc);
  switch (d.kind) {
    case 'percent-probability':
      // The validator rejects these as E_PROB_RANGE; the lesson explains why in student terms.
      return events.some((e) => e.probability > 1 && e.probability <= 100);
    case 'single-input-gate':
      return gates.some((g) => g.type !== 'atleast' && new Set(g.inputs).size === 1);
    case 'wrong-top-gate': {
      const t = gates.find((g) => g.id === top);
      return t !== undefined && t.type !== d.expected;
    }
    case 'no-shared-event': {
      // Several events with the same probability and no event under two gates: the "two copies" shape.
      const counts = parentCounts(gates);
      return gates.length >= 2 && ![...counts.values()].some((n) => n >= 2);
    }
    case 'unused-event': {
      const used = new Set(gates.flatMap((g) => g.inputs));
      return events.some((e) => e.id !== top && !used.has(e.id));
    }
  }
}

export interface LessonProgress {
  steps: { id: string; done: boolean }[];
  mistakes: { id: string; message: string }[];
  complete: boolean;
}

export function checkLesson(lesson: Lesson, doc: LessonDoc): LessonProgress {
  const steps = lesson.steps.map((s) => ({ id: s.id, done: runCheck(s.check, doc) }));
  const mistakes = lesson.mistakes.filter((m) => runDetect(m.detect, doc)).map((m) => ({ id: m.id, message: m.message }));
  return { steps, mistakes, complete: steps.every((s) => s.done) && mistakes.length === 0 };
}

/** Compare an engine result with a lesson outcome. The caller has already required a completed, complete result. */
export function matchOutcome(lesson: Lesson, probability: number, cutSets: string[][]): Outcome | null {
  const key = (c: string[][]): string => JSON.stringify(c.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join().localeCompare(b.join())));
  return lesson.outcomes.find((o) => Math.abs(o.probability - probability) <= o.tolerance.absolute && key(o.cut_sets) === key(cutSets)) ?? null;
}
