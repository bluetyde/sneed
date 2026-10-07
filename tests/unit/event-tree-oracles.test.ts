import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeEventTree } from '../../src/engines/bdd/event-tree.js';
import { eventKey, type EtOracleEntry } from '../../src/core/event-tree-lesson.js';
import { skeletonSequences } from '../../src/core/event-tree.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerateEventTree } from '../oracle/event-tree.js';
import { mkDoc } from '../oracle/models.js';

const oracles = JSON.parse(readFileSync(new URL('../event-tree-oracles.json', import.meta.url), 'utf8')) as (EtOracleEntry & { description: string; derivation: string; tolerance: { absolute: number } })[];

/** The tree of an entry in the app's own terms: headings H1, H2, ... with their conditions turned into heading ids. */
function treeOf(e: EtOracleEntry) {
  const headings = e.headings.map((h, i) => ({
    id: `H${i + 1}`,
    event: h.event,
    ...(h.asked_only_if ? { asked_only_if: { heading: `H${e.headings.findIndex((x) => x.event === h.asked_only_if!.event) + 1}`, branch: h.asked_only_if.branch } } : {}),
  }));
  return {
    initiating_event: { frequency: e.initiating_frequency },
    headings,
    end_states: [{ id: 'E', name: 'E', synthetic: true }],
    sequences: skeletonSequences(headings, 'E'),
  };
}
const modelOf = (e: EtOracleEntry) => {
  const doc = mkDoc(e.model.top, Object.fromEntries(e.model.events.map((x) => [x.id, x.probability])), e.model.gates.map((g) => ({ id: g.id, type: g.type as 'and' | 'or', inputs: g.inputs })) as never);
  return doc;
};

describe('the event-tree oracle entries (the numbers the lessons are graded against)', () => {
  it('there is an entry for each lesson case, each with a derivation and a tolerance within the lessons\' limit', () => {
    expect(oracles.map((o) => o.id)).toEqual(['et-independent', 'et-shared', 'et-bypass']);
    for (const o of oracles) {
      expect(o.derivation.length).toBeGreaterThan(20);
      expect(o.tolerance.absolute).toBeLessThanOrEqual(1e-9);
      expect(new Set(o.sequences.map((s) => eventKey(s.path))).size).toBe(o.sequences.length);
    }
  });

  it('every probability and frequency equals the independent exact enumeration (rational arithmetic, sharing no code with the engine)', () => {
    for (const o of oracles) {
      const t = treeOf(o);
      const exact = enumerateEventTree(modelOf(o) as never, { ...t, end_states: [{ id: 'E' }], sequences: t.sequences });
      const headingEvent = new Map(t.headings.map((h) => [h.id, h.event]));
      let sumP = 0;
      for (const s of t.sequences) {
        const key = s.path.map((st) => `${st.heading}:${st.branch}`).join(',');
        const entry = o.sequences.find((x) => eventKey(x.path) === eventKey(s.path.map((st) => ({ event: headingEvent.get(st.heading)!, branch: st.branch }))))!;
        expect(entry, `${o.id} ${key}`).toBeDefined();
        const p = exact.probability.get(key)!.toNumber();
        const f = exact.frequency.get(key)!.toNumber();
        expect(entry.probability, `${o.id} ${key} probability`).toBe(p);
        expect(entry.frequency, `${o.id} ${key} frequency`).toBe(f);
        sumP += entry.probability;
      }
      expect(o.sequences).toHaveLength(t.sequences.length);
      expect(sumP).toBeCloseTo(1, 12);
    }
  });

  it('the engine agrees with every entry', () => {
    for (const o of oracles) {
      const t = treeOf(o);
      const r = computeEventTree(modelOf(o) as unknown as NativeModel, t);
      const eventOf = new Map(t.headings.map((h) => [h.id, h.event]));
      for (const s of r.sequences) {
        const entry = o.sequences.find((x) => eventKey(x.path) === eventKey(s.path.map((st) => ({ event: eventOf.get(st.heading)!, branch: st.branch }))))!;
        expect(Math.abs(s.frequency - entry.frequency), `${o.id} ${s.key}`).toBeLessThanOrEqual(o.tolerance.absolute);
        expect(Math.abs(s.probability - entry.probability)).toBeLessThanOrEqual(o.tolerance.absolute);
      }
    }
  });

  it('the hand numbers of plan 13 sections 6.1, 6.2 and 6.4', () => {
    const f = (id: string, key: string): number => oracles.find((o) => o.id === id)!.sequences.find((s) => eventKey(s.path) === key)!.frequency;
    expect(f('et-independent', 'INJ:works,COOL:works')).toBe(0.0891);
    expect(f('et-independent', 'INJ:fails,COOL:fails')).toBe(0.0001);
    expect(f('et-shared', 'X:fails,Y:fails')).toBe(0.077);
    expect(f('et-shared', 'X:fails,Y:works')).toBe(0.063);
    expect(f('et-bypass', 'X:fails')).toBe(0.14);
    expect(f('et-bypass', 'X:works,Y:works')).toBe(0.252);
  });
});
