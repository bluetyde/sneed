// Compare two saved event-tree analyses (docs/plans/13-event-trees.md, stage S4): what differs in the tree and what differs in the frequencies.
// Pure functions over untrusted data (saved files can be edited by hand); nothing here evaluates anything. A difference is reported as a
// difference: nothing says one analysis is better, safer or more correct than the other. Numbers are compared only when BOTH analyses are
// complete: a failed or cancelled analysis has none, and "every sequence was removed" would be a false thing to say about it.

export interface Change<T> {
  from: T;
  to: T;
}
export interface Moved {
  from: number;
  to: number;
  delta: number;
  /** to / from; null when from is 0. */
  ratio: number | null;
}

export interface EtSequenceLine {
  key: string;
  /** The path in words (heading names, or ids when the other run has no such heading). */
  words: string;
  end_state: string;
  frequency: number;
}
export interface EtResultDiff {
  runs: { a: { status: string | null; completeness: string | null }; b: { status: string | null; completeness: string | null } };
  /** Both analyses are complete, so their numbers were compared. */
  numbersCompared: boolean;
  /** A record that says it is complete but whose rows or total are damaged: its numbers are not trusted, so not compared. */
  malformed: { a: boolean; b: boolean };
  initiating: { name: Change<string> | null; frequency: Moved | null };
  headings: { added: string[]; removed: string[]; changed: { id: string; name: Change<string> | null; event: Change<string> | null }[] };
  sequences: { added: EtSequenceLine[]; removed: EtSequenceLine[]; changed: { key: string; words: string; frequency: Moved | null; end_state: Change<string> | null }[]; unchanged: number };
  endStates: { added: { id: string; name: string; frequency: number }[]; removed: { id: string; name: string; frequency: number }[]; changed: { id: string; name: string; frequency: Moved }[]; unchanged: number };
  total: Moved | null;
  assumptions: { key: string; from: string | null; to: string | null }[];
  engine: Change<string> | null;
  /** Both records state the engine's name, version AND full build hash. Without that, "same engine" is not a claim anyone can make. */
  engineKnown: boolean;
  sameTree: boolean;
  sameModel: boolean;
  /** Same tree meaning, same fault-tree model and same engine build, each stated in both records: any difference in the numbers is then unexpected. */
  sameInputs: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface ReadRecord {
  status: string | null;
  completeness: string | null;
  complete: boolean;
  treeHash: string | null;
  modelHash: string | null;
  engine: string | null;
  engineSha: string | null;
  ieName: string | null;
  ieFrequency: number | null;
  headings: Map<string, { id: string; name: string; event: string }>;
  sequences: Map<string, { key: string; path: { heading: string; branch: string }[]; end_state: string; frequency: number }>;
  endStates: Map<string, { id: string; name: string; frequency: number }>;
  total: number | null;
  assumptions: Map<string, string>;
  /** Some row or the total was not readable although the record claims to be complete. */
  malformed: boolean;
}

/** Reads an event-tree result record without trusting its shape. Null when it is not a recognisable one. */
export function readEventTreeRecord(raw: unknown): ReadRecord | null {
  if (!isObj(raw) || !isObj(raw.schema) || raw.schema.id !== 'sneed.event-tree-result') return null;
  const headings = new Map<string, { id: string; name: string; event: string }>();
  if (Array.isArray(raw.headings)) for (const h of raw.headings) if (isObj(h) && str(h.id)) headings.set(h.id, { id: h.id, name: str(h.name) ? h.name : h.id, event: str(h.event) ? h.event : '' });
  let damaged = false;
  const sequences = new Map<string, { key: string; path: { heading: string; branch: string }[]; end_state: string; frequency: number }>();
  if (!Array.isArray(raw.sequences)) damaged = true;
  if (Array.isArray(raw.sequences)) {
    for (const s of raw.sequences) {
      if (!isObj(s) || !str(s.key) || !num(s.frequency)) {
        damaged = true;
        continue;
      }
      const path = Array.isArray(s.path) ? s.path.filter(isObj).map((p) => ({ heading: str(p.heading) ? p.heading : '?', branch: str(p.branch) ? p.branch : '?' })) : [];
      sequences.set(s.key, { key: s.key, path, end_state: str(s.end_state) ? s.end_state : '', frequency: s.frequency });
    }
  }
  const endStates = new Map<string, { id: string; name: string; frequency: number }>();
  if (!Array.isArray(raw.end_states)) damaged = true;
  if (Array.isArray(raw.end_states)) {
    for (const e of raw.end_states) {
      if (isObj(e) && str(e.id) && num(e.frequency)) endStates.set(e.id, { id: e.id, name: str(e.name) ? e.name : e.id, frequency: e.frequency });
      else damaged = true;
    }
  }
  const assumptions = new Map<string, string>();
  if (isObj(raw.assumptions)) for (const [k, v] of Object.entries(raw.assumptions)) assumptions.set(k, typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined');
  const hashes = isObj(raw.input_hashes) ? raw.input_hashes : {};
  const eng = isObj(raw.engine) ? raw.engine : {};
  const ie = isObj(raw.initiating_event) ? raw.initiating_event : {};
  const total = isObj(raw.total) ? raw.total : {};
  const status = str(raw.status) ? raw.status : null;
  const completeness = str(raw.completeness) ? raw.completeness : null;
  return {
    status,
    completeness,
    complete: status === 'completed' && completeness === 'complete',
    treeHash: str(hashes.tree_hash) ? hashes.tree_hash : null,
    modelHash: str(hashes.model_hash) ? hashes.model_hash : null,
    engine: str(eng.name) ? `${eng.name} ${str(eng.version) ? eng.version : '?'}`.trim() : null,
    engineSha: str(eng.sha256) ? eng.sha256 : null,
    ieName: str(ie.name) ? ie.name : null,
    ieFrequency: num(ie.frequency) ? ie.frequency : null,
    headings,
    sequences,
    endStates,
    total: num(total.frequency) ? total.frequency : null,
    assumptions,
    // a complete record has a total and rows that can all be read; the check applies only to a record that claims to be complete
    malformed: status === 'completed' && completeness === 'complete' && (damaged || !num(total.frequency)),
  };
}

const moved = (from: number, to: number): Moved | null => (from === to ? null : { from, to, delta: to - from, ratio: from === 0 ? null : to / from });

/** The path in words: heading names from the later record when it knows the heading, else the earlier one, else the id. */
function words(path: { heading: string; branch: string }[], ...from: ReadRecord['headings'][]): string {
  return path.map((p) => `${from.map((h) => h.get(p.heading)?.name).find((n) => n !== undefined) ?? p.heading} ${p.branch}`).join(', ');
}

/** Null when either record is not a recognisable event-tree result. `a` is the earlier analysis and `b` the later one. */
export function diffEventTreeResults(rawA: unknown, rawB: unknown): EtResultDiff | null {
  const a = readEventTreeRecord(rawA);
  const b = readEventTreeRecord(rawB);
  if (!a || !b) return null;
  const numbers = a.complete && b.complete && !a.malformed && !b.malformed;

  const hAdded = [...b.headings.keys()].filter((k) => !a.headings.has(k));
  const hRemoved = [...a.headings.keys()].filter((k) => !b.headings.has(k));
  const hChanged: EtResultDiff['headings']['changed'] = [];
  for (const [id, ha] of a.headings) {
    const hb = b.headings.get(id);
    if (!hb) continue;
    const name = ha.name !== hb.name ? { from: ha.name, to: hb.name } : null;
    const event = ha.event !== hb.event ? { from: ha.event, to: hb.event } : null;
    if (name || event) hChanged.push({ id, name, event });
  }

  const seqs: EtResultDiff['sequences'] = { added: [], removed: [], changed: [], unchanged: 0 };
  const ends: EtResultDiff['endStates'] = { added: [], removed: [], changed: [], unchanged: 0 };
  if (numbers) {
    for (const [key, sb] of b.sequences) {
      const sa = a.sequences.get(key);
      if (!sa) {
        seqs.added.push({ key, words: words(sb.path, b.headings, a.headings), end_state: sb.end_state, frequency: sb.frequency });
        continue;
      }
      const frequency = moved(sa.frequency, sb.frequency);
      const end_state = sa.end_state !== sb.end_state ? { from: sa.end_state, to: sb.end_state } : null;
      if (frequency || end_state) seqs.changed.push({ key, words: words(sb.path, b.headings, a.headings), frequency, end_state });
      else seqs.unchanged++;
    }
    for (const [key, sa] of a.sequences) if (!b.sequences.has(key)) seqs.removed.push({ key, words: words(sa.path, a.headings, b.headings), end_state: sa.end_state, frequency: sa.frequency });
    for (const [id, eb] of b.endStates) {
      const ea = a.endStates.get(id);
      if (!ea) ends.added.push({ id, name: eb.name, frequency: eb.frequency });
      else {
        const m = moved(ea.frequency, eb.frequency);
        if (m) ends.changed.push({ id, name: eb.name, frequency: m });
        else ends.unchanged++;
      }
    }
    for (const [id, ea] of a.endStates) if (!b.endStates.has(id)) ends.removed.push({ id, name: ea.name, frequency: ea.frequency });
  }

  const keys = [...new Set([...a.assumptions.keys(), ...b.assumptions.keys()])].sort();
  const assumptions = keys.map((key) => ({ key, from: a.assumptions.get(key) ?? null, to: b.assumptions.get(key) ?? null })).filter((x) => x.from !== x.to);
  // the identity compared is the full build hash; only the label shows 12 characters of it
  const identity = (r: ReadRecord): string | null => (r.engine === null || r.engineSha === null || r.engineSha === '' ? null : `${r.engine} build ${r.engineSha}`);
  const label = (r: ReadRecord): string | null => (r.engine === null ? null : `${r.engine}${r.engineSha ? ` build ${r.engineSha.slice(0, 12)}` : ''}`);
  const idA = identity(a);
  const idB = identity(b);
  const engineA = label(a);
  const engineB = label(b);
  const sameTree = a.treeHash !== null && a.treeHash === b.treeHash;
  const sameModel = a.modelHash !== null && a.modelHash === b.modelHash;
  return {
    runs: { a: { status: a.status, completeness: a.completeness }, b: { status: b.status, completeness: b.completeness } },
    numbersCompared: numbers,
    malformed: { a: a.malformed, b: b.malformed },
    initiating: { name: a.ieName !== null && b.ieName !== null && a.ieName !== b.ieName ? { from: a.ieName, to: b.ieName } : null, frequency: a.ieFrequency !== null && b.ieFrequency !== null ? moved(a.ieFrequency, b.ieFrequency) : null },
    headings: { added: hAdded, removed: hRemoved, changed: hChanged },
    sequences: seqs,
    endStates: ends,
    total: numbers && a.total !== null && b.total !== null ? moved(a.total, b.total) : null,
    assumptions,
    engine: engineA !== null && engineB !== null && (idA !== idB || engineA !== engineB) ? { from: engineA, to: engineB } : null,
    engineKnown: idA !== null && idB !== null,
    sameTree,
    sameModel,
    sameInputs: sameTree && sameModel && idA !== null && idA === idB,
  };
}
