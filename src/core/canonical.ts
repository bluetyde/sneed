import { createHash } from 'node:crypto';

/** RFC 8785 (JCS) subset: objects, arrays, strings, booleans, finite numbers. See plan 01. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number refused');
    return Object.is(v, -0) ? '0' : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

interface Doc {
  schema: { id: string; version: number };
  assumptions: unknown;
  top: string;
  events: { id: string; probability: number }[];
  gates: { id: string; type: string; inputs: string[]; threshold?: number }[];
}

/** Semantic projection hashed as model_hash. Callers validate first; duplicates are refused here too. */
export function projection(doc: Doc): unknown {
  const events: Record<string, number> = {};
  for (const e of doc.events) {
    if (Object.hasOwn(events, e.id)) throw new Error('E_DUP_ID event ' + e.id);
    events[e.id] = e.probability;
  }
  const gates: Record<string, unknown> = {};
  for (const g of doc.gates) {
    if (Object.hasOwn(gates, g.id) || Object.hasOwn(events, g.id)) throw new Error('E_DUP_ID gate ' + g.id);
    const entry: Record<string, unknown> = { type: g.type, inputs: [...g.inputs].sort() };
    if (g.threshold !== undefined) entry.threshold = g.threshold;
    gates[g.id] = entry;
  }
  return { schema: { id: doc.schema.id, version: doc.schema.version }, assumptions: doc.assumptions, top: doc.top, events, gates };
}

export const modelHash = (doc: Doc): string => createHash('sha256').update(canon(projection(doc)), 'utf8').digest('hex');
export const documentHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
