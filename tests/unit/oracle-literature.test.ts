import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { solve } from '../../src/engines/bdd/solve.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerate, topOccurs, type NativeDoc } from '../oracle/enumerate.js';
import { AND, OR, mkDoc } from '../oracle/models.js';
import { Q, qFromNumber } from '../oracle/rational.js';

// Literature oracles (docs/oracles.md): worked examples of NUREG-0492, the Fault Tree Handbook, read from the NRC's own copy. The structure and the
// numbers come from tests/oracles-literature.json, which says where on which page. Nothing here is computed by the code under test.

interface Entry {
  id: string;
  model: { top: string; events: Record<string, number>; gates: { id: string; type: 'and' | 'or'; inputs: string[] }[] };
  published: {
    minimal_cut_sets: string[][];
    cut_set_probabilities?: Record<string, number>;
    top_event_printed?: number;
    importance_printed_percent?: Record<string, number | string>;
    not_minimal_example_per_the_handbook?: string[];
  };
}
const file = JSON.parse(readFileSync(new URL('../oracles-literature.json', import.meta.url), 'utf8')) as { entries: Entry[] };
const entry = (id: string): Entry => file.entries.find((e) => e.id === id)!;
const docOf = (e: Entry) => mkDoc(e.model.top, e.model.events, e.model.gates.map((g) => (g.type === 'and' ? AND(g.id, g.inputs) : OR(g.id, g.inputs))));
const sorted = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
const key = (set: string[]): string => [...set].sort().join(',');
const product = (e: Entry, set: string[]): Q => set.reduce((acc, id) => acc.mul(qFromNumber(e.model.events[id]!)), Q.ONE);

describe('the oracle file itself', () => {
  it('has the two examples, each with a source page and a published list of minimal cut sets', () => {
    expect(file.entries.map((e) => e.id)).toEqual(['nureg0492-pressure-tank', 'nureg0492-three-motor-2']);
    expect(entry('nureg0492-pressure-tank').published.minimal_cut_sets).toHaveLength(5);
    expect(entry('nureg0492-three-motor-2').published.minimal_cut_sets).toHaveLength(7);
  });
});

describe('NUREG-0492, the pressure tank example (Chapter VIII, pages VIII-12 to VIII-14)', () => {
  const e = entry('nureg0492-pressure-tank');
  const doc = docOf(e);
  const solution = solve(doc as unknown as NativeModel);

  it('the five minimal cut sets the handbook prints are the ones the solver finds, and the independent enumerator finds', () => {
    expect(sorted(solution.cutSets.map((c) => c.events))).toEqual(sorted(e.published.minimal_cut_sets));
    expect(sorted(enumerate(doc as NativeDoc).cutSets)).toEqual(sorted(e.published.minimal_cut_sets));
  });

  it('each cut set probability the handbook prints is the product of its Table VIII-1 values, exactly, and is what the solver reports', () => {
    for (const [name, printed] of Object.entries(e.published.cut_set_probabilities!)) {
      const set = name.split(',');
      expect(product(e, set).eq(qFromNumber(printed)), `${name}: the product of the table values is the printed value`).toBe(true);
      const found = solution.cutSets.find((c) => key(c.events) === key(set))!;
      expect(Math.abs(found.probability - printed) <= 1e-15 * Math.max(1, printed / 1e-9), `${name}: ${found.probability} vs ${printed}`).toBe(true);
    }
  });

  it('the rare-event sum of the printed cut set probabilities is 3.5016e-5, the solver reports it, and the exact probability is the same to better than 1e-5 of itself (the handbook calls the approximation applicable)', () => {
    const printed = Object.values(e.published.cut_set_probabilities!).reduce((acc, p) => acc.add(qFromNumber(p)), Q.ZERO);
    expect(printed.eq(qFromNumber(3.5016e-5))).toBe(true); // 5e-6 + 3e-5 + 3e-9 + 1e-8 + 3e-9
    const sum = solution.cutSets.reduce((acc, c) => acc + c.probability, 0);
    expect(Math.abs(sum - printed.toNumber())).toBeLessThanOrEqual(1e-15);
    const exact = enumerate(doc as NativeDoc).probability; // exact rational, independent of the solver
    expect(Math.abs(solution.probability - exact.toNumber())).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(printed.toNumber() - exact.toNumber()) / exact.toNumber()).toBeLessThan(1e-5);
  });

  it('the importances the handbook prints (14 percent, 86 percent, under 0.1 percent) are the shares of the cut set sum, to the whole percent', () => {
    const total = Object.values(e.published.cut_set_probabilities!).reduce((a, p) => a + p, 0);
    const share = (name: string): number => (100 * e.published.cut_set_probabilities![name]!) / total;
    expect(Math.round(share('T'))).toBe(e.published.importance_printed_percent!['T']);
    expect(Math.round(share('K2'))).toBe(e.published.importance_printed_percent!['K2']);
    for (const name of ['K1,S', 'R,S', 'S,S1']) expect(share(name)).toBeLessThan(0.1);
  });

  it('the handbook\'s printed top value, 3.4e-5, does NOT equal the sum of its own printed cut set probabilities: the gap (about 2.9 percent) is pinned, and the printed importances agree with the sum, not with 3.4e-5', () => {
    const printedTop = e.published.top_event_printed!;
    const total = Object.values(e.published.cut_set_probabilities!).reduce((a, p) => a + p, 0);
    const gap = (total - printedTop) / total;
    expect(gap).toBeGreaterThan(0.028);
    expect(gap).toBeLessThan(0.030);
    // if the printed top value were right, the shares would be 15 and 88 percent, not the 14 and 86 the handbook prints
    expect(Math.round((100 * 5e-6) / printedTop)).toBe(15);
    expect(Math.round((100 * 3e-5) / printedTop)).toBe(88);
    expect(Math.round((100 * 5e-6) / total)).toBe(e.published.importance_printed_percent!['T']);
  });
});

describe('NUREG-0492, the three motor example, overrun of Motor 2 (Chapter IX, pages IX-7 and IX-8)', () => {
  const e = entry('nureg0492-three-motor-2');
  const doc = docOf(e);

  it('the seven minimal cut sets the handbook prints are the ones the solver finds, and the enumerator finds (repeated events K1, S1 and KT2 appear in more than one branch)', () => {
    const published = sorted(e.published.minimal_cut_sets);
    expect(sorted(solve(doc as unknown as NativeModel).cutSets.map((c) => c.events))).toEqual(published);
    expect(sorted(enumerate(doc as NativeDoc).cutSets)).toEqual(published);
  });

  it('K3 K1 K2, which the handbook names as not minimal, is a cut set but is not listed, and removing any event from each published cut set stops the top event', () => {
    const named = e.published.not_minimal_example_per_the_handbook!;
    expect(topOccurs(doc as NativeDoc, new Set(named))).toBe(true); // it does cause the top event
    expect(sorted(solve(doc as unknown as NativeModel).cutSets.map((c) => c.events)).map(key)).not.toContain(key(named));
    for (const set of e.published.minimal_cut_sets) {
      for (const drop of set) expect(topOccurs(doc as NativeDoc, new Set(set.filter((x) => x !== drop))), `${key(set)} without ${drop}`).toBe(false);
    }
  });
});
