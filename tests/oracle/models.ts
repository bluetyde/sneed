// Native-document builders for the frozen hand oracles (tests/oracles.json) and a seeded random-tree generator.
// Test code only. Expected values are never computed here; they come from tests/oracles.json.
import type { NativeDoc } from './enumerate.js';

export type Doc = NativeDoc & Record<string, unknown>;
type Gate = NativeDoc['gates'][number];

const HEAD = {
  schema: { id: 'sneed.fault-tree', version: 1 },
  model: { id: 'oracle', name: 'Oracle model', created: '2026-10-05T00:00:00Z', updated: '2026-10-05T00:00:00Z' },
  assumptions: { probability_model: 'constant', independence: 'declared-independent', coherence: 'coherent', time: 'none' },
};

export const AND = (id: string, inputs: string[]): Gate => ({ id, type: 'and', inputs });
export const OR = (id: string, inputs: string[]): Gate => ({ id, type: 'or', inputs });
export const VOTE = (id: string, inputs: string[], threshold: number): Gate => ({ id, type: 'atleast', inputs, threshold });

export function mkDoc(top: string, events: Record<string, number>, gates: Gate[]): Doc {
  return {
    ...HEAD,
    top,
    events: Object.entries(events).map(([id, probability]) => ({ id, probability })),
    gates,
  } as Doc;
}

const three = { A: 0.1, B: 0.1, C: 0.1 };
const expansion = [OR('TOP', ['AB', 'AC', 'BC']), AND('AB', ['A', 'B']), AND('AC', ['A', 'C']), AND('BC', ['B', 'C'])];

/** The numerical entries of tests/oracles.json, as native models. The approximation rows reuse the 2-of-3 model. */
export const ORACLE_MODELS: Record<string, Doc> = {
  'pra-and': mkDoc('TOP', { A: 0.1, B: 0.2 }, [AND('TOP', ['A', 'B'])]),
  'pra-or': mkDoc('TOP', { A: 0.1, B: 0.2 }, [OR('TOP', ['A', 'B'])]),
  'pra-aa': mkDoc('TOP', { A: 0.1 }, [AND('TOP', ['A', 'A'])]),
  'pra-oa': mkDoc('TOP', { A: 0.1 }, [OR('TOP', ['A', 'A'])]),
  'pra-shared': mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.3 }, [OR('TOP', ['AB', 'AC']), AND('AB', ['A', 'B']), AND('AC', ['A', 'C'])]),
  'pra-pump1': mkDoc('P', { P: 0.1 }, []),
  'pra-pump2-and': mkDoc('TOP', { P1: 0.1, P2: 0.1 }, [AND('TOP', ['P1', 'P2'])]),
  'pra-pump2-or': mkDoc('TOP', { P1: 0.1, P2: 0.1 }, [OR('TOP', ['P1', 'P2'])]),
  'pra-pump3-shared': mkDoc('TOP', { P1: 0.1, P2: 0.1, S: 0.05 }, [OR('TOP', ['S', 'PUMPS']), AND('PUMPS', ['P1', 'P2'])]),
  'pra-pump3-separate': mkDoc('TOP', { P1: 0.1, P2: 0.1, S1: 0.05, S2: 0.05 }, [AND('TOP', ['L', 'R']), OR('L', ['P1', 'S1']), OR('R', ['P2', 'S2'])]),
  'pra-vote-exact': mkDoc('TOP', three, expansion),
  'pra-vote-rare': mkDoc('TOP', three, expansion),
  'pra-vote-mcub': mkDoc('TOP', three, expansion),
};
/** Same 2-of-3 logic written with the native voting gate. */
export const NATIVE_VOTE: Doc = mkDoc('V', three, [VOTE('V', ['A', 'B', 'C'], 2)]);

/** Deterministic PRNG (mulberry32) so a failing seed can be replayed exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomOptions {
  events?: number;
  gates?: number;
}

/** A random coherent tree: gates only use earlier nodes, so it is acyclic; reuse of nodes makes repeated events. */
export function randomDoc(seed: number, opts: RandomOptions = {}): Doc {
  const rnd = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const nEvents = opts.events ?? int(2, 10);
  const nGates = opts.gates ?? int(1, 8);
  const fixed = [0, 1, 0.5, 0.1, 0.05, 0.3, 0.001];
  const events: Record<string, number> = {};
  const nodes: string[] = [];
  for (let i = 0; i < nEvents; i++) {
    const id = `E${i}`;
    events[id] = rnd() < 0.5 ? pick(fixed) : int(1, 9999) / 10000;
    nodes.push(id);
  }
  const gates: Gate[] = [];
  for (let g = 0; g < nGates; g++) {
    const id = `G${g}`;
    const recent = nodes.slice(-6);
    const choose = (): string => (rnd() < 0.6 ? pick(recent) : pick(nodes));
    const kind = rnd();
    if (kind < 0.2 && nodes.length >= 4) {
      const arity = int(3, Math.min(5, nodes.length));
      const ins = new Set<string>();
      while (ins.size < arity) ins.add(choose());
      gates.push(VOTE(id, [...ins], int(2, arity - 1)));
    } else {
      const arity = int(2, 4);
      gates.push({ id, type: kind < 0.6 ? 'and' : 'or', inputs: Array.from({ length: arity }, choose) });
    }
    nodes.push(id);
  }
  return mkDoc(gates.length ? gates[gates.length - 1]!.id : 'E0', events, gates);
}
