// Compare two saved runs (docs/plans/03-editor.md, "Compare"): what differs in the model and what differs in the result.
// Pure functions over untrusted data (saved files can be edited by hand); nothing here evaluates or executes anything.
// A difference is reported as a difference. Nothing here says one run is better, safer or more correct than the other.

export interface Change<T> {
  from: T;
  to: T;
}

export interface EventChange {
  id: string;
  probability: Change<number> | null;
  name: Change<string | null> | null;
}
export interface GateChange {
  id: string;
  type: Change<string> | null;
  threshold: Change<number | null> | null;
  inputs: Change<string[]> | null;
}
export interface ModelDiff {
  top: Change<string> | null;
  events: { added: string[]; removed: string[]; changed: EventChange[] };
  gates: { added: string[]; removed: string[]; changed: GateChange[] };
  /** True when nothing that affects the analysis differs (names and notes count only where listed above). */
  identical: boolean;
}

export interface CutSetChange {
  events: string[];
  probability: Change<number>;
}
export interface ResultDiff {
  status: Change<string> | null;
  completeness: Change<string> | null;
  /** What each run is, always: a comparison of numbers must say whether each side is a complete result. */
  runs: { a: { status: string | null; completeness: string | null }; b: { status: string | null; completeness: string | null } };
  method: Change<string> | null;
  probability: { from: number | null; to: number | null; delta: number | null; ratio: number | null };
  cutSets: { added: { events: string[]; probability: number }[]; removed: { events: string[]; probability: number }[]; changed: CutSetChange[]; unchanged: number };
  assumptions: { key: string; from: string | null; to: string | null }[];
  engine: Change<string> | null;
  /** The two runs analysed the same model (same semantic hash). */
  sameModel: boolean;
  /** Same model, same method and same engine build, each stated in both records: any difference in the numbers is then unexpected. */
  sameInputs: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface ReadEvent { id: string; probability: number | null; name: string | null }
interface ReadGate { id: string; type: string; threshold: number | null; inputs: string[] }
interface ReadDoc { top: string; events: Map<string, ReadEvent>; gates: Map<string, ReadGate> }

/** Reads a native document without trusting its shape. Null when it is not a recognisable model. */
export function readDoc(raw: unknown): ReadDoc | null {
  if (!isObj(raw) || !Array.isArray(raw.events) || !Array.isArray(raw.gates)) return null;
  const events = new Map<string, ReadEvent>();
  for (const e of raw.events) {
    if (!isObj(e) || !str(e.id)) return null;
    events.set(e.id, { id: e.id, probability: num(e.probability) ? e.probability : null, name: str(e.name) && e.name !== '' ? e.name : null });
  }
  const gates = new Map<string, ReadGate>();
  for (const g of raw.gates) {
    if (!isObj(g) || !str(g.id) || !str(g.type) || !Array.isArray(g.inputs) || !g.inputs.every(str)) return null;
    gates.set(g.id, { id: g.id, type: g.type, threshold: num(g.threshold) ? g.threshold : null, inputs: g.inputs as string[] });
  }
  return { top: str(raw.top) ? raw.top : '', events, gates };
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function diffModels(a: unknown, b: unknown): ModelDiff | null {
  const x = readDoc(a);
  const y = readDoc(b);
  if (!x || !y) return null;
  const events = { added: [] as string[], removed: [] as string[], changed: [] as EventChange[] };
  for (const id of y.events.keys()) if (!x.events.has(id)) events.added.push(id);
  for (const [id, e] of x.events) {
    const f = y.events.get(id);
    if (!f) {
      events.removed.push(id);
      continue;
    }
    const probability = e.probability !== f.probability ? { from: e.probability as number, to: f.probability as number } : null;
    const name = e.name !== f.name ? { from: e.name, to: f.name } : null;
    if (probability || name) events.changed.push({ id, probability, name });
  }
  const gates = { added: [] as string[], removed: [] as string[], changed: [] as GateChange[] };
  for (const id of y.gates.keys()) if (!x.gates.has(id)) gates.added.push(id);
  for (const [id, g] of x.gates) {
    const h = y.gates.get(id);
    if (!h) {
      gates.removed.push(id);
      continue;
    }
    const type = g.type !== h.type ? { from: g.type, to: h.type } : null;
    const threshold = g.threshold !== h.threshold ? { from: g.threshold, to: h.threshold } : null;
    // input order does not change the logic, so it is not a difference; a repeated input is kept (it is a repeated reference)
    const inputs = !same([...g.inputs].sort(), [...h.inputs].sort()) ? { from: g.inputs, to: h.inputs } : null;
    if (type || threshold || inputs) gates.changed.push({ id, type, threshold, inputs });
  }
  const top = x.top !== y.top ? { from: x.top, to: y.top } : null;
  const logic = events.added.length + events.removed.length + gates.added.length + gates.removed.length + gates.changed.length + events.changed.filter((e) => e.probability).length;
  return { top, events, gates, identical: top === null && logic === 0 };
}

const key = (events: string[]): string => JSON.stringify([...events].sort());

/** The part of a results record the comparison relies on. A record without it is unreadable, not "empty". */
function usable(r: unknown): r is Record<string, unknown> {
  if (!isObj(r) || !str(r.status) || !Array.isArray(r.minimal_cut_sets)) return false;
  return r.minimal_cut_sets.every((c) => isObj(c) && Array.isArray(c.events) && c.events.every(str) && num(c.probability));
}

export function diffResults(a: unknown, b: unknown): ResultDiff | null {
  if (!usable(a) || !usable(b)) return null;
  const change = (f: unknown, t: unknown): Change<string> | null => (str(f) && str(t) && f !== t ? { from: f, to: t } : null);
  const pa = num(a.top_event_probability) ? a.top_event_probability : null;
  const pb = num(b.top_event_probability) ? b.top_event_probability : null;
  const sets = (r: Record<string, unknown>): Map<string, { events: string[]; probability: number }> => {
    const m = new Map<string, { events: string[]; probability: number }>();
    for (const c of r.minimal_cut_sets as { events: string[]; probability: number }[]) m.set(key(c.events), { events: [...c.events].sort(), probability: c.probability });
    return m;
  };
  const sa = sets(a);
  const sb = sets(b);
  const cut = { added: [] as { events: string[]; probability: number }[], removed: [] as { events: string[]; probability: number }[], changed: [] as CutSetChange[], unchanged: 0 };
  for (const [k, v] of sb) if (!sa.has(k)) cut.added.push(v);
  for (const [k, v] of sa) {
    const w = sb.get(k);
    if (!w) cut.removed.push(v);
    else if (w.probability !== v.probability) cut.changed.push({ events: v.events, probability: { from: v.probability, to: w.probability } });
    else cut.unchanged++;
  }
  const order = (x: { events: string[] }, y: { events: string[] }): number => x.events.length - y.events.length || key(x.events).localeCompare(key(y.events));
  cut.added.sort(order);
  cut.removed.sort(order);
  cut.changed.sort(order);

  const asm = (r: Record<string, unknown>): Map<string, string> => new Map(isObj(r.assumptions) ? Object.entries(r.assumptions).map(([k, v]) => [k, String(v)]) : []);
  const ma = asm(a);
  const mb = asm(b);
  const assumptions: ResultDiff['assumptions'] = [];
  for (const k of [...new Set([...ma.keys(), ...mb.keys()])].sort()) {
    const f = ma.get(k) ?? null;
    const t = mb.get(k) ?? null;
    if (f !== t) assumptions.push({ key: k, from: f, to: t });
  }

  const eng = (r: Record<string, unknown>): string | null => (isObj(r.engine) && str(r.engine.name) && str(r.engine.version) ? `${r.engine.name} ${r.engine.version}` : null);
  const build = (r: Record<string, unknown>): string | null => (isObj(r.engine) && str(r.engine.sha256) && r.engine.sha256 !== '' ? r.engine.sha256 : null);
  const state = (r: Record<string, unknown>): { status: string | null; completeness: string | null } => ({ status: str(r.status) ? r.status : null, completeness: str(r.completeness) ? r.completeness : null });
  const ea = eng(a);
  const eb = eng(b);
  const hash = (r: Record<string, unknown>): string | null => (isObj(r.input_hashes) && str(r.input_hashes.model_hash) ? r.input_hashes.model_hash : null);
  const ha = hash(a);
  const hb = hash(b);
  const sameModel = ha !== null && ha === hb;
  const method = change(a.method, b.method);
  const engine = ea !== null && eb !== null && ea !== eb ? { from: ea, to: eb } : null;
  // "nothing differs" is not "the same": method, engine name and version and the engine build must each be present in both records and equal
  const sameEngine = ea !== null && ea === eb && build(a) !== null && build(a) === build(b);
  const sameMethod = str(a.method) && a.method === b.method;
  return {
    status: change(a.status, b.status),
    completeness: change(a.completeness, b.completeness),
    runs: { a: state(a), b: state(b) },
    method,
    probability: { from: pa, to: pb, delta: pa !== null && pb !== null ? pb - pa : null, ratio: pa !== null && pb !== null && pa !== 0 ? pb / pa : null },
    cutSets: cut,
    assumptions,
    engine,
    sameModel,
    sameInputs: sameModel && sameMethod && sameEngine,
  };
}
