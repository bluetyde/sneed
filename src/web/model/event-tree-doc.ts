// Editing operations on an event-tree document (docs/plans/13-event-trees.md). Every function returns a new document and never changes
// its input. Nothing here validates: the server's validator is the arbiter, so a half-finished tree shows named problems instead of
// being blocked. The sequence list is always the complete list the headings allow, regenerated after any change to the headings.
import { MAX_HEADINGS, enumeratePaths, pathKey, type Branch, type PathStep } from '../../core/event-tree-paths.js';

export interface EtHeading {
  id: string;
  name: string;
  event: string;
  asked_only_if?: { heading: string; branch: Branch };
}
export interface EtEndState {
  id: string;
  name: string;
  description: string;
  synthetic: boolean;
}
export interface EtSequence {
  path: PathStep[];
  end_state: string;
}
export interface EtDoc {
  schema: { id: string; version: number };
  tree: { id: string; name: string; created: string; updated: string };
  fault_tree_model: { name: string; model_hash: string };
  initiating_event: { name: string; description: string; frequency: number; unit: string };
  headings: EtHeading[];
  end_states: EtEndState[];
  sequences: EtSequence[];
  assumptions: Record<string, unknown>;
  [extra: string]: unknown;
}

export const V1_ASSUMPTIONS = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' } as const;
/** Stands in for a model hash until a fault-tree model is chosen (the schema wants 64 hex digits). */
export const NO_MODEL_HASH = '0'.repeat(64);

const clone = <T>(v: T): T => structuredClone(v);

export function newEventTree(model: { name: string; hash: string; top: string } | null, name = 'Untitled event tree', now = new Date().toISOString()): EtDoc {
  const doc: EtDoc = {
    schema: { id: 'sneed.event-tree', version: 1 },
    tree: { id: 'tree', name, created: now, updated: now },
    fault_tree_model: { name: model?.name ?? 'none', model_hash: model?.hash ?? NO_MODEL_HASH },
    initiating_event: { name: 'Initiating event', description: 'A teaching example', frequency: 0.1, unit: 'per-year' },
    headings: [{ id: 'H1', name: 'Heading 1', event: model?.top ?? 'none' }],
    end_states: [{ id: 'ES1', name: 'End state 1 (example)', description: 'An example condition, not a real plant state', synthetic: true }],
    sequences: [],
    assumptions: { ...V1_ASSUMPTIONS },
  };
  return withSequences(doc, []);
}

export function serialize(doc: EtDoc): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** The complete sequence list the headings allow. A path that existed before keeps its end state; a new path has none ("choose"). */
export function withSequences(doc: EtDoc, previous: EtSequence[]): EtDoc {
  const had = new Map(previous.map((s) => [pathKey(s.path), s.end_state]));
  const next = clone(doc);
  next.sequences = enumeratePaths(next.headings).map((path) => ({ path, end_state: had.get(pathKey(path)) ?? '' }));
  return next;
}

const stamp = (doc: EtDoc, now: string): EtDoc => ({ ...doc, tree: { ...doc.tree, updated: now } });
const nextId = (prefix: string, taken: string[]): string => {
  for (let i = taken.length + 1; ; i++) if (!taken.includes(`${prefix}${i}`)) return `${prefix}${i}`;
};

export function setTreeName(doc: EtDoc, name: string, now = new Date().toISOString()): EtDoc {
  return stamp({ ...doc, tree: { ...doc.tree, name } }, now);
}
export function setInitiating(doc: EtDoc, patch: Partial<EtDoc['initiating_event']>, now = new Date().toISOString()): EtDoc {
  return stamp({ ...doc, initiating_event: { ...doc.initiating_event, ...patch } }, now);
}
export function setModelRef(doc: EtDoc, ref: { name: string; hash: string }, now = new Date().toISOString()): EtDoc {
  return stamp({ ...doc, fault_tree_model: { name: ref.name, model_hash: ref.hash } }, now);
}

// ---- headings
export function addHeading(doc: EtDoc, event: string, now = new Date().toISOString()): EtDoc {
  if (doc.headings.length >= MAX_HEADINGS) return doc;
  const id = nextId('H', doc.headings.map((h) => h.id));
  const next = clone(doc);
  next.headings.push({ id, name: `Heading ${doc.headings.length + 1}`, event });
  return stamp(withSequences(next, doc.sequences), now);
}
export function removeHeading(doc: EtDoc, id: string, now = new Date().toISOString()): EtDoc {
  if (doc.headings.length <= 1) return doc;
  const next = clone(doc);
  next.headings = next.headings.filter((h) => h.id !== id);
  // a heading that was asked only if the removed one went a certain way is asked always: the author sees the new paths and chooses
  for (const h of next.headings) if (h.asked_only_if?.heading === id) delete h.asked_only_if;
  return stamp(withSequences(next, doc.sequences), now);
}
export function moveHeading(doc: EtDoc, id: string, by: -1 | 1, now = new Date().toISOString()): EtDoc {
  const i = doc.headings.findIndex((h) => h.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= doc.headings.length) return doc;
  const next = clone(doc);
  [next.headings[i], next.headings[j]] = [next.headings[j]!, next.headings[i]!];
  // order decides which headings a condition may name (earlier ones only): a condition that now points forward is dropped
  next.headings.forEach((h, k) => {
    if (h.asked_only_if && next.headings.findIndex((x) => x.id === h.asked_only_if!.heading) >= k) delete h.asked_only_if;
  });
  return stamp(withSequences(next, doc.sequences), now);
}
export function patchHeading(doc: EtDoc, id: string, patch: { name?: string; event?: string }, now = new Date().toISOString()): EtDoc {
  const next = clone(doc);
  const h = next.headings.find((x) => x.id === id);
  if (!h) return doc;
  Object.assign(h, patch);
  return stamp(next, now);
}
/** `null` means asked on every path. */
export function setBypass(doc: EtDoc, id: string, cond: { heading: string; branch: Branch } | null, now = new Date().toISOString()): EtDoc {
  const next = clone(doc);
  const h = next.headings.find((x) => x.id === id);
  if (!h) return doc;
  if (cond) h.asked_only_if = { heading: cond.heading, branch: cond.branch };
  else delete h.asked_only_if;
  return stamp(withSequences(next, doc.sequences), now);
}

// ---- end states
export function addEndState(doc: EtDoc, now = new Date().toISOString()): EtDoc {
  const id = nextId('ES', doc.end_states.map((e) => e.id));
  const next = clone(doc);
  next.end_states.push({ id, name: `End state ${doc.end_states.length + 1} (example)`, description: 'An example condition, not a real plant state', synthetic: true });
  return stamp(next, now);
}
/** Sequences that ended in the removed state have none again (the author must choose). */
export function removeEndState(doc: EtDoc, id: string, now = new Date().toISOString()): EtDoc {
  if (doc.end_states.length <= 1) return doc;
  const next = clone(doc);
  next.end_states = next.end_states.filter((e) => e.id !== id);
  for (const s of next.sequences) if (s.end_state === id) s.end_state = '';
  return stamp(next, now);
}
export function patchEndState(doc: EtDoc, id: string, patch: Partial<Omit<EtEndState, 'id'>>, now = new Date().toISOString()): EtDoc {
  const next = clone(doc);
  const e = next.end_states.find((x) => x.id === id);
  if (!e) return doc;
  Object.assign(e, patch);
  return stamp(next, now);
}
export function setSequenceEnd(doc: EtDoc, key: string, endState: string, now = new Date().toISOString()): EtDoc {
  const next = clone(doc);
  const s = next.sequences.find((x) => pathKey(x.path) === key);
  if (!s) return doc;
  s.end_state = endState;
  return stamp(next, now);
}
/** Gives every sequence that has no end state this one. */
export function setUnsetEnds(doc: EtDoc, endState: string, now = new Date().toISOString()): EtDoc {
  const next = clone(doc);
  for (const s of next.sequences) if (s.end_state === '') s.end_state = endState;
  return stamp(next, now);
}
