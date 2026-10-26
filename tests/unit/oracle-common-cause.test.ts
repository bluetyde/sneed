import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Q, qFromNumber } from '../oracle/rational.js';

// The frozen common-cause oracles (tests/oracles-common-cause.json, plan 15). No common-cause code exists yet, so this test checks the
// frozen numbers against an independent exact evaluation of the group definition. The engines are checked against the same file at stage C2.

interface Entry {
  id: string;
  type: string;
  group: { id: string; members: string[]; q: number; beta: number };
  logic: { kind: 'and' | 'or' | 'atleast'; k?: number };
  outside?: { id: string; probability: number };
  expected_probability: number;
  expected_cut_sets: string[][] | null;
  independent_value: number;
  tolerance: { absolute: number; relative: number };
}
const entries = JSON.parse(readFileSync(join(import.meta.dirname, '../oracles-common-cause.json'), 'utf8')) as Entry[];

/** The group as defined in plan 15, section 2: member i fails when its independent part I_i occurs or the group event C occurs. Sums over every state of C and the I_i. */
function groupProbability(e: Entry, beta: Q): Q {
  const q = qFromNumber(e.group.q);
  const pC = beta.mul(q);
  const pI = Q.ONE.sub(beta).mul(q);
  const n = e.group.members.length;
  let total = Q.ZERO;
  for (let state = 0; state < 2 ** (n + 1); state++) {
    const c = (state & 1) === 1;
    let w = c ? pC : Q.ONE.sub(pC);
    let failed = 0;
    for (let i = 0; i < n; i++) {
      const ind = ((state >> (i + 1)) & 1) === 1;
      w = w.mul(ind ? pI : Q.ONE.sub(pI));
      if (c || ind) failed++;
    }
    const top = e.logic.kind === 'and' ? failed === n : e.logic.kind === 'or' ? failed >= 1 : failed >= (e.logic.k ?? n + 1);
    if (top) total = total.add(w);
  }
  return total;
}

/** The same model with independent members only (no group): the textbook value. */
function independentProbability(e: Entry): Q {
  const q = qFromNumber(e.group.q);
  const n = e.group.members.length;
  let total = Q.ZERO;
  for (let state = 0; state < 2 ** n; state++) {
    let w = Q.ONE;
    let failed = 0;
    for (let i = 0; i < n; i++) {
      const f = ((state >> i) & 1) === 1;
      w = w.mul(f ? q : Q.ONE.sub(q));
      if (f) failed++;
    }
    const top = e.logic.kind === 'and' ? failed === n : e.logic.kind === 'or' ? failed >= 1 : failed >= (e.logic.k ?? n + 1);
    if (top) total = total.add(w);
  }
  return total;
}

/** An event outside the group joined by OR: 1 - (1 - P(group part)) * (1 - P(outside)). */
const withOutside = (e: Entry, part: Q): Q => (e.outside ? Q.ONE.sub(Q.ONE.sub(part).mul(Q.ONE.sub(qFromNumber(e.outside.probability)))) : part);

const close = (exact: Q, frozen: number, tol: number): boolean => Math.abs(exact.toNumber() - frozen) <= tol;

describe('frozen common-cause oracles (tests/oracles-common-cause.json), reproduced by exact evaluation of the group definition', () => {
  it('holds the seven cases of plan 15, each once', () => {
    expect(entries.map((e) => e.id)).toEqual(['cc-and', 'cc-or', 'cc-vote', 'cc-and-beta0', 'cc-or-beta0', 'cc-and-beta1', 'cc-outside-event']);
    for (const e of entries) {
      expect(e.type).toBe('numerical');
      expect(e.group.members.length).toBeGreaterThanOrEqual(2);
      expect(e.group.beta).toBeGreaterThanOrEqual(0);
      expect(e.group.beta).toBeLessThanOrEqual(1);
    }
  });

  for (const e of entries) {
    it(`${e.id}: the frozen probability and the frozen independent value are the exact values`, () => {
      expect(close(withOutside(e, groupProbability(e, qFromNumber(e.group.beta))), e.expected_probability, e.tolerance.absolute)).toBe(true);
      expect(close(withOutside(e, independentProbability(e)), e.independent_value, e.tolerance.absolute)).toBe(true);
    });
  }

  it('the zero check: with beta = 0 the group value is exactly the independent value', () => {
    for (const e of entries.filter((x) => x.group.beta === 0)) {
      expect(groupProbability(e, Q.ZERO).eq(independentProbability(e))).toBe(true);
    }
    // and for every case, setting beta to 0 gives the independent value, whatever beta was frozen
    for (const e of entries) expect(groupProbability(e, Q.ZERO).eq(independentProbability(e))).toBe(true);
  });

  it('the closed forms of plan 15 agree with the exact evaluation, computed again by hand formulas', () => {
    const byId = (id: string): Entry => entries.find((e) => e.id === id)!;
    const beta = qFromNumber(0.1);
    const q = qFromNumber(0.1);
    const pC = beta.mul(q);
    const pI = Q.ONE.sub(beta).mul(q);
    // AND of two: P(C) + (1 - P(C)) * P(I)^2
    expect(groupProbability(byId('cc-and'), beta).eq(pC.add(Q.ONE.sub(pC).mul(pI).mul(pI)))).toBe(true);
    // OR of two: 1 - (1 - P(I))^2 * (1 - P(C))
    const nI = Q.ONE.sub(pI);
    expect(groupProbability(byId('cc-or'), beta).eq(Q.ONE.sub(nI.mul(nI).mul(Q.ONE.sub(pC))))).toBe(true);
    // 2-of-3: 1 - (1 - P(C)) * (1 - (3 * P(I)^2 * (1 - P(I)) + P(I)^3))
    const three = Q.make(3n, 1n).mul(pI).mul(pI).mul(nI).add(pI.mul(pI).mul(pI));
    expect(groupProbability(byId('cc-vote'), beta).eq(Q.ONE.sub(Q.ONE.sub(pC).mul(Q.ONE.sub(three))))).toBe(true);
  });

  it('beta = 1 makes the members fail together: the AND is as likely as one member', () => {
    const e = entries.find((x) => x.id === 'cc-and-beta1')!;
    expect(groupProbability(e, Q.ONE).eq(qFromNumber(e.group.q))).toBe(true);
  });

  it('the frozen cut sets name the group event and the independent parts, and none is a superset of another', () => {
    for (const e of entries.filter((x) => x.expected_cut_sets)) {
      const sets = e.expected_cut_sets!.map((s) => new Set(s));
      for (const [i, a] of sets.entries()) {
        for (const [j, b] of sets.entries()) if (i !== j) expect([...a].every((x) => b.has(x))).toBe(false);
        for (const name of a) expect(name === `${e.group.id}.CCF` || name === e.outside?.id || e.group.members.some((m) => name === `${m}.independent`)).toBe(true);
      }
    }
  });
});
