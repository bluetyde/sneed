import { expandGroups } from './ccf.js';
import type { NativeModel } from './model.js';

export const EXPORTER_VERSION = 'sneed-export-1';

/** How a native K-of-N gate is written. SCRAM's own `atleast` was found to be unreliable (docs/spike/README.md). */
export type VotingMode = 'native' | 'expand' | 'auto';

export interface ExportOptions {
  voting?: VotingMode;
}

/** Largest OR-of-ANDs a voting gate may expand to; beyond this the export is refused, not silently approximated. */
export const MAX_VOTE_TERMS = 2000;

export class ExportError extends Error {
  constructor(
    readonly code: 'E_EXPORT_LIMIT',
    message: string,
    readonly ids: string[],
  ) {
    super(message);
  }
}

const choose = (n: number, k: number): number => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
};

export interface ExportMapping {
  /** Name of the wrapper gate written for a basic-event top, if one was needed. */
  wrapperGate: string | null;
  /** Native gate id -> id it was replaced by (all inputs resolved to one reference). */
  collapsed: Record<string, string>;
  /** Voting gates written as an OR of ANDs because two inputs resolved to the same reference. */
  expandedVotes: string[];
  /** Ids written to the XML, sorted. */
  gates: string[];
  events: string[];
  /** The id the exported top gate carries (the wrapper's name when a wrapper was needed). */
  top: string;
  /**
   * Only for a model with common-cause groups: the event names written to the XML -> the names the model uses. SCRAM refuses a dot in a name
   * (docs/spike/README.md), so `G.CCF` is written as `G__CCF`. Absent when no name was changed.
   */
  renamed?: Record<string, string>;
}

export interface Exported {
  xml: string;
  mapping: ExportMapping;
}

/** A probability as a plain decimal (no exponent), exact for the double's shortest round-trip text. */
export function xmlFloat(p: number): string {
  const t = JSON.stringify(p);
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(t);
  if (!m) return t;
  const frac = m[2] ?? '';
  const digits = m[1]! + frac;
  const shift = Number(m[3]) - frac.length; // value = digits * 10^shift
  if (shift >= 0) return digits + '0'.repeat(shift);
  const s = -shift;
  const padded = digits.padStart(s + 1, '0');
  return padded.slice(0, padded.length - s) + '.' + padded.slice(padded.length - s);
}

/**
 * The events the expansion of a group adds have a dot in their name (`G.CCF`, `A.independent`), and a valid id never has one.
 * SCRAM reads a dot as the Open-PSA path separator, so the XML gets `G__CCF` instead. A name that is already taken gets a number.
 * Returns the model to write and the names to translate back (written name -> model name).
 */
function safeNames(model: NativeModel): { model: NativeModel; renamed: Record<string, string> } {
  const dotted = model.events.filter((e) => e.id.includes('.'));
  if (dotted.length === 0) return { model, renamed: {} };
  const taken = new Set<string>([...model.events.map((e) => e.id), ...model.gates.map((g) => g.id)]);
  const to = new Map<string, string>();
  const renamed = Object.create(null) as Record<string, string>; // no prototype: any id is an ordinary key
  for (const e of dotted) {
    const base = e.id.replaceAll('.', '__');
    let name = base;
    for (let i = 1; taken.has(name); i++) name = `${base}_${i}`;
    taken.add(name);
    to.set(e.id, name);
    renamed[name] = e.id;
  }
  const nm = (id: string): string => to.get(id) ?? id;
  return { model: { ...model, events: model.events.map((e) => ({ ...e, id: nm(e.id) })), gates: model.gates.map((g) => ({ ...g, inputs: g.inputs.map(nm) })) }, renamed };
}

type Formula = { ref: string } | { op: 'and' | 'or'; args: Formula[] } | { op: 'atleast'; min: number; args: Formula[] };

/**
 * Exports a validated native model to Open-PSA XML for SCRAM (docs/OPEN-PSA-SUBSET.md).
 * Identity is preserved: a repeated event is never copied, duplicate inputs collapse, and anything
 * SCRAM cannot express directly (duplicate inputs on a voting gate) is rewritten to equivalent AND/OR logic.
 */
export function exportOpenPsa(input: NativeModel, options: ExportOptions = {}): Exported {
  // common-cause groups are written as their expansion (plan 15, section 4); a name with a dot is written with a name SCRAM accepts
  const { model: exportable, renamed } = safeNames(expandGroups(input));
  const model = exportable;
  const voting: VotingMode = options.voting ?? 'auto';
  const gateById = new Map(model.gates.map((g) => [g.id, g]));

  // resolve: follow gates whose inputs all resolve to the same reference (AND/OR only)
  const resolved = new Map<string, string>();
  const resolve = (id: string): string => {
    const hit = resolved.get(id);
    if (hit !== undefined) return hit;
    const g = gateById.get(id);
    let out = id;
    if (g && g.type !== 'atleast') {
      const distinct = [...new Set(g.inputs.map(resolve))];
      if (distinct.length === 1) out = distinct[0]!;
    }
    resolved.set(id, out);
    return out;
  };

  const formulas = new Map<string, Formula>();
  const expandedVotes: string[] = [];
  const formulaOf = (id: string): Formula => {
    const hit = formulas.get(id);
    if (hit) return hit;
    const g = gateById.get(id)!;
    const ins = g.inputs.map(resolve);
    let f: Formula;
    if (g.type === 'atleast') {
      const k = g.threshold!;
      const distinct = new Set(ins).size === ins.length;
      const allEvents = ins.every((x) => !gateById.has(x));
      const useNative = distinct && (voting === 'native' || (voting === 'auto' && allEvents));
      if (useNative) {
        f = { op: 'atleast', min: k, args: ins.map((ref) => ({ ref })) };
      } else {
        if (choose(ins.length, k) > MAX_VOTE_TERMS) {
          throw new ExportError('E_EXPORT_LIMIT', `voting gate ${JSON.stringify(id)} (${k} of ${ins.length}) expands to more than ${MAX_VOTE_TERMS} terms`, [id]);
        }
        // written as an OR over the k-combinations of input positions, each AND over its distinct references
        expandedVotes.push(id);
        const combos = new Map<string, string[]>();
        const walk = (start: number, chosen: string[]): void => {
          if (chosen.length === k) {
            const distinct = [...new Set(chosen)].sort();
            combos.set(distinct.join('\u0000'), distinct);
            return;
          }
          for (let i = start; i < ins.length; i++) walk(i + 1, [...chosen, ins[i]!]);
        };
        walk(0, []);
        const terms: Formula[] = [...combos.values()].map((c) => (c.length === 1 ? { ref: c[0]! } : { op: 'and', args: c.map((ref) => ({ ref })) }));
        f = terms.length === 1 ? terms[0]! : { op: 'or', args: terms };
      }
    } else {
      f = { op: g.type, args: [...new Set(ins)].map((ref) => ({ ref })) };
    }
    formulas.set(id, f);
    return f;
  };

  // emitted structure: everything reachable from the resolved top
  const topResolved = resolve(model.top);
  const emittedGates: string[] = [];
  const emittedEvents = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!gateById.has(id)) {
      emittedEvents.add(id);
      return;
    }
    emittedGates.push(id);
    const refs: string[] = [];
    const collect = (f: Formula): void => {
      if ('ref' in f) refs.push(f.ref);
      else f.args.forEach(collect);
    };
    collect(formulaOf(id));
    refs.forEach(visit);
  };
  visit(topResolved);

  const used = new Set<string>([...emittedGates, ...emittedEvents]);
  let wrapperGate: string | null = null;
  if (!gateById.has(topResolved)) {
    let name = 'TOP';
    for (let i = 1; used.has(name) || model.events.some((e) => e.id === name) || gateById.has(name); i++) name = `TOP_${i}`;
    wrapperGate = name;
  }

  const probs = new Map(model.events.map((e) => [e.id, e.probability]));
  const kind = (ref: string): string => (gateById.has(ref) ? 'gate' : 'basic-event');
  const render = (f: Formula, indent: string): string => {
    if ('ref' in f) return `${indent}<${kind(f.ref)} name="${f.ref}"/>`;
    const open = f.op === 'atleast' ? `<atleast min="${f.min}">` : `<${f.op}>`;
    return [`${indent}${open}`, ...f.args.map((a) => render(a, indent + '  ')), `${indent}</${f.op}>`].join('\n');
  };

  const lines: string[] = ['<?xml version="1.0"?>', '<opsa-mef>', '  <define-fault-tree name="SNEED">'];
  if (wrapperGate) {
    lines.push(`    <define-gate name="${wrapperGate}">`, render({ ref: topResolved }, '      '), '    </define-gate>');
  }
  for (const id of [...emittedGates].sort()) {
    lines.push(`    <define-gate name="${id}">`, render(formulaOf(id), '      '), '    </define-gate>');
  }
  for (const id of [...emittedEvents].sort()) {
    lines.push(`    <define-basic-event name="${id}">`, `      <float value="${xmlFloat(probs.get(id)!)}"/>`, '    </define-basic-event>');
  }
  lines.push('  </define-fault-tree>', '</opsa-mef>', '');

  const collapsed = Object.create(null) as Record<string, string>; // no prototype: a gate called __proto__ is an ordinary key
  for (const [id, to] of resolved) if (id !== to && gateById.has(id)) collapsed[id] = to;
  return {
    xml: lines.join('\n'),
    mapping: {
      wrapperGate,
      collapsed,
      expandedVotes: expandedVotes.sort(),
      gates: [...emittedGates].sort(),
      events: [...emittedEvents].sort(),
      top: wrapperGate ?? topResolved,
      ...(Object.keys(renamed).length ? { renamed } : {}),
    },
  };
}
