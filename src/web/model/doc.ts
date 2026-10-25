// Editing operations on a native document. Every function returns a new document and never changes its input;
// unknown fields are carried along untouched. Nothing here validates: the validator (on the server) is the arbiter,
// so a student can build a cycle or a one-input AND and see the named problem instead of being blocked.

export type GateType = 'and' | 'or' | 'atleast';

export interface EventNode {
  id: string;
  name?: string;
  probability: number;
  source?: { kind: string; citation?: string };
  note?: string;
  [extra: string]: unknown;
}

export interface GateNode {
  id: string;
  name?: string;
  type: GateType;
  inputs: string[];
  threshold?: number;
  [extra: string]: unknown;
}

export interface Layout {
  nodes?: { id: string; x: number; y: number }[];
  references?: { node: string; target: string; x: number; y: number }[];
  [extra: string]: unknown;
}

/** A common-cause group (plan 15): the members are basic events that can fail together, with the beta-factor model. */
export interface GroupNode {
  id: string;
  name?: string;
  method: 'beta-factor';
  members: string[];
  beta: number;
  [extra: string]: unknown;
}

export interface Doc {
  schema: { id: string; version: number };
  model: { id: string; name: string; created: string; updated: string };
  assumptions: Record<string, unknown>;
  top: string;
  events: EventNode[];
  gates: GateNode[];
  common_cause_groups?: GroupNode[];
  layout?: Layout;
  [extra: string]: unknown;
}

export const DEFAULT_PROBABILITY = 0.1;
export const DEFAULT_BETA = 0.1;
const clone = <T>(v: T): T => structuredClone(v);

export function newModel(name = 'Untitled model', now = new Date().toISOString()): Doc {
  return {
    schema: { id: 'sneed.fault-tree', version: 1 },
    model: { id: 'model', name, created: now, updated: now },
    assumptions: { probability_model: 'constant', independence: 'declared-independent', coherence: 'coherent', time: 'none' },
    top: 'G1',
    events: [
      { id: 'E1', probability: DEFAULT_PROBABILITY },
      { id: 'E2', probability: DEFAULT_PROBABILITY },
    ],
    gates: [{ id: 'G1', type: 'or', inputs: ['E1', 'E2'] }],
  };
}

/** A model with nothing in it. The first node added becomes the top (see addEvent), so a lesson can start from nothing. */
export function emptyModel(name = 'Untitled model', now = new Date().toISOString()): Doc {
  return { ...newModel(name, now), top: '', events: [], gates: [] };
}

export const isGate = (doc: Doc, id: string): boolean => doc.gates.some((g) => g.id === id);
export const isEvent = (doc: Doc, id: string): boolean => doc.events.some((e) => e.id === id);
export const findGate = (doc: Doc, id: string): GateNode | undefined => doc.gates.find((g) => g.id === id);
export const findEvent = (doc: Doc, id: string): EventNode | undefined => doc.events.find((e) => e.id === id);
export const exists = (doc: Doc, id: string): boolean => isGate(doc, id) || isEvent(doc, id);
export const groups = (doc: Doc): GroupNode[] => doc.common_cause_groups ?? [];
export const findGroup = (doc: Doc, id: string): GroupNode | undefined => groups(doc).find((g) => g.id === id);
/** The group an event belongs to, if any. */
export const groupOf = (doc: Doc, eventId: string): GroupNode | undefined => groups(doc).find((g) => g.members.includes(eventId));

/** The smallest unused identifier `<prefix><n>`, so ids are short, stable and valid by construction. */
export function nextId(doc: Doc, prefix: 'E' | 'G' | 'CC'): string {
  const used = new Set([...doc.events.map((e) => e.id), ...doc.gates.map((g) => g.id), ...groups(doc).map((g) => g.id)]);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

export interface Added {
  doc: Doc;
  id: string;
}

/** A new basic event. With a parent gate it becomes that gate's last input; the first node of an empty model becomes the top. */
export function addEvent(doc: Doc, opts: { parent?: string; probability?: number } = {}): Added {
  const d = clone(doc);
  const id = nextId(d, 'E');
  d.events.push({ id, probability: opts.probability ?? DEFAULT_PROBABILITY });
  if (opts.parent) findGate(d, opts.parent)?.inputs.push(id);
  else if (!d.top) d.top = id;
  return { doc: d, id };
}

/**
 * A new gate with two new basic events as inputs, so it is valid at once. With a parent gate it becomes that gate's
 * last input. A K-of-N gate starts as 2 of 3 (three new events).
 */
export function addGate(doc: Doc, type: GateType, opts: { parent?: string } = {}): Added {
  let d = clone(doc);
  const id = nextId(d, 'G');
  const gate: GateNode = { id, type, inputs: [] };
  if (type === 'atleast') gate.threshold = 2;
  d.gates.push(gate);
  const count = type === 'atleast' ? 3 : 2;
  for (let i = 0; i < count; i++) d = addEvent(d, { parent: id }).doc;
  if (opts.parent) findGate(d, opts.parent)?.inputs.push(id);
  else if (!d.top) d.top = id;
  return { doc: d, id };
}

/** Adds an existing node as another input of a gate. Repeating an id is allowed: it is a repeated reference, not a copy. */
export function connect(doc: Doc, gateId: string, childId: string): Doc {
  const d = clone(doc);
  const g = findGate(d, gateId);
  if (!g) return d;
  g.inputs.push(childId);
  return d;
}

/** Removes one input slot of a gate (by position, so a repeated reference removes only that occurrence). */
export function disconnect(doc: Doc, gateId: string, index: number): Doc {
  const d = clone(doc);
  const g = findGate(d, gateId);
  if (g && index >= 0 && index < g.inputs.length) g.inputs.splice(index, 1);
  return d;
}

/** Deletes a node everywhere: from the lists, from every gate's inputs, from the layout, and from `top`. */
export function removeNode(doc: Doc, id: string): Doc {
  const d = clone(doc);
  d.events = d.events.filter((e) => e.id !== id);
  d.gates = d.gates.filter((g) => g.id !== id);
  for (const g of d.gates) g.inputs = g.inputs.filter((x) => x !== id);
  for (const g of groups(d)) g.members = g.members.filter((x) => x !== id);
  tidyGroups(d);
  if (d.top === id) d.top = '';
  if (d.layout?.nodes) d.layout.nodes = d.layout.nodes.filter((n) => n.id !== id);
  if (d.layout?.references) d.layout.references = d.layout.references.filter((r) => r.target !== id && !r.node.startsWith(`${id}#`));
  return d;
}

export const setTop = (doc: Doc, id: string): Doc => ({ ...clone(doc), top: id });

/** Sets the probability of an event. The members of a common-cause group share one probability, so setting one sets them all. */
export function setProbability(doc: Doc, id: string, probability: number): Doc {
  const d = clone(doc);
  const e = findEvent(d, id);
  if (!e) return d;
  const members = groupOf(d, id)?.members ?? [id];
  for (const m of members) {
    const x = findEvent(d, m);
    if (x) x.probability = probability;
  }
  return d;
}

// ---- common-cause groups (plan 15) ----
/**
 * Keeps the document consistent after a change to the groups: a group left with fewer than two members is removed (it would be
 * refused by the validator and means nothing), and the assumptions say whether groups are in use (E_CCF_ASSUMPTION otherwise).
 */
function tidyGroups(d: Doc): void {
  if (d.common_cause_groups) {
    d.common_cause_groups = d.common_cause_groups.filter((g) => g.members.length >= 2);
    if (d.common_cause_groups.length === 0) delete d.common_cause_groups;
  }
  const used = groups(d).length > 0;
  if (used || d.assumptions.independence === 'beta-factor-groups') d.assumptions = { ...d.assumptions, independence: used ? 'beta-factor-groups' : 'declared-independent' };
}

/** A new group of two or more events that are not in a group yet. They all take the probability of the first one. Returns id '' when nothing was made. */
export function addGroup(doc: Doc, memberIds: string[], opts: { beta?: number; name?: string } = {}): Added {
  const d = clone(doc);
  const members = [...new Set(memberIds)].filter((m) => isEvent(d, m) && !groupOf(d, m));
  if (members.length < 2) return { doc, id: '' };
  const id = nextId(d, 'CC');
  const q = findEvent(d, members[0]!)!.probability;
  for (const m of members) findEvent(d, m)!.probability = q;
  const group: GroupNode = { id, ...(opts.name ? { name: opts.name } : {}), method: 'beta-factor', members, beta: opts.beta ?? DEFAULT_BETA };
  d.common_cause_groups = [...groups(d), group];
  tidyGroups(d);
  return { doc: d, id };
}

/** Adds an event (not in a group yet) to a group. It takes the probability the group's members share. */
export function addToGroup(doc: Doc, groupId: string, eventId: string): Doc {
  const d = clone(doc);
  const g = findGroup(d, groupId);
  const e = findEvent(d, eventId);
  if (!g || !e || groupOf(d, eventId)) return d;
  const q = findEvent(d, g.members[0]!)?.probability;
  if (q !== undefined) e.probability = q;
  g.members.push(eventId);
  return d;
}

/** Takes an event out of a group. A group left with one member is removed. */
export function removeFromGroup(doc: Doc, groupId: string, eventId: string): Doc {
  const d = clone(doc);
  const g = findGroup(d, groupId);
  if (!g) return d;
  g.members = g.members.filter((m) => m !== eventId);
  tidyGroups(d);
  return d;
}

export function removeGroup(doc: Doc, groupId: string): Doc {
  const d = clone(doc);
  d.common_cause_groups = groups(d).filter((g) => g.id !== groupId);
  tidyGroups(d);
  return d;
}

/** Sets beta as given: the editor checks the range, and the validator is the arbiter. */
export function setBeta(doc: Doc, groupId: string, beta: number): Doc {
  const d = clone(doc);
  const g = findGroup(d, groupId);
  if (g) g.beta = beta;
  return d;
}

export function setGroupName(doc: Doc, groupId: string, name: string): Doc {
  const d = clone(doc);
  const g = findGroup(d, groupId);
  if (g) {
    if (name === '') delete g.name;
    else g.name = name;
  }
  return d;
}

/** Sets or clears (empty string) the display name of an event or gate. IDs never change. */
export function setName(doc: Doc, id: string, name: string): Doc {
  const d = clone(doc);
  const n = findEvent(d, id) ?? findGate(d, id);
  if (n) {
    if (name === '') delete n.name;
    else n.name = name;
  }
  return d;
}

export function setNote(doc: Doc, id: string, note: string): Doc {
  const d = clone(doc);
  const e = findEvent(d, id);
  if (e) {
    if (note === '') delete e.note;
    else e.note = note;
  }
  return d;
}

export function setSource(doc: Doc, id: string, kind: string, citation?: string): Doc {
  const d = clone(doc);
  const e = findEvent(d, id);
  if (!e) return d;
  if (kind === '') delete e.source;
  else e.source = kind === 'sourced' ? { kind, citation: citation ?? '' } : { kind };
  return d;
}

/** Changes a gate's type. K-of-N gets a threshold of 2; AND and OR lose theirs. */
export function setGateType(doc: Doc, id: string, type: GateType): Doc {
  const d = clone(doc);
  const g = findGate(d, id);
  if (!g) return d;
  g.type = type;
  if (type === 'atleast') g.threshold = g.threshold ?? 2;
  else delete g.threshold;
  return d;
}

export function setThreshold(doc: Doc, id: string, threshold: number): Doc {
  const d = clone(doc);
  const g = findGate(d, id);
  if (g && g.type === 'atleast') g.threshold = threshold;
  return d;
}

export function setModelName(doc: Doc, name: string): Doc {
  const d = clone(doc);
  d.model.name = name;
  return d;
}

/** Stamps the update time. Metadata only: it changes the document hash, never the model hash. */
export function touch(doc: Doc, now = new Date().toISOString()): Doc {
  const d = clone(doc);
  d.model.updated = now;
  return d;
}

/** Records a position for a visual node: a node id, or `<parentId>#<slot>` for a repeated reference. Layout only. */
export function moveNode(doc: Doc, key: string, x: number, y: number): Doc {
  const d = clone(doc);
  const layout = (d.layout ??= {});
  const ref = /^(.*)#(\d+)$/.exec(key);
  if (ref) {
    const parent = findGate(d, ref[1]!);
    const target = parent?.inputs[Number(ref[2])];
    if (!target) return d;
    const list = (layout.references ??= []);
    const at = list.find((r) => r.node === key);
    if (at) {
      at.x = x;
      at.y = y;
      at.target = target;
    } else list.push({ node: key, target, x, y });
  } else {
    const list = (layout.nodes ??= []);
    const at = list.find((n) => n.id === key);
    if (at) {
      at.x = x;
      at.y = y;
    } else list.push({ id: key, x, y });
  }
  return d;
}

/** Forgets every stored position so the automatic tidy layout applies again. */
export function resetLayout(doc: Doc): Doc {
  const d = clone(doc);
  delete d.layout;
  return d;
}

/** The text that is saved and sent to the server: two-space JSON, a trailing newline, keys in document order. */
export const serialize = (doc: Doc): string => JSON.stringify(doc, null, 2) + '\n';

/** Opens a saved model for editing. A file the editor cannot draw (events or gates that are not lists) is refused, never repaired, so it is not overwritten by accident. */
export function parseDoc(text: string): Doc {
  const v = JSON.parse(text) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('a model is a JSON object');
  const d = v as Partial<Doc>;
  if (!Array.isArray(d.events) || !Array.isArray(d.gates)) throw new Error('"events" and "gates" must both be lists, so this file cannot be drawn; it was not changed');
  return { ...(v as Doc), top: typeof d.top === 'string' ? d.top : '' };
}
