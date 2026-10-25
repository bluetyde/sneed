import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeEventTreeBuiltin } from '../../src/engines/bdd/event-tree-analyze.js';
import { importance } from '../../src/engines/bdd/importance.js';
import { derivedEventNames, expandGroups } from '../../src/core/ccf.js';
import { modelHash } from '../../src/core/canonical.js';
import { skeletonSequences, type PathStep } from '../../src/core/event-tree.js';
import type { NativeModel } from '../../src/core/model.js';
import { IMPORTANCE_ASSUMPTIONS, IMPORTANCE_GROUPS_NOTE } from '../../src/core/importance.js';
import { startServer } from '../../src/server/app.js';
import { enumerate } from '../oracle/enumerate.js';
import { enumerateEventTree } from '../oracle/event-tree.js';
import { frozenCaseDoc, groupsToPlain, randomGroupDoc, type FrozenCase, type GroupDoc } from '../oracle/groups.js';

// Plan 15, after stage C4: event trees and importance measures take a model with common-cause groups. Both are made on the expansion (src/core/ccf.ts)
// and checked against oracles that evaluate the plain tree of the group definition (tests/oracle/groups.ts), which shares no code with it.

const frozen = JSON.parse(readFileSync(path.join(import.meta.dirname, '../oracles-common-cause.json'), 'utf8')) as FrozenCase[];
const cc = (id: string): GroupDoc => frozenCaseDoc(frozen.find((e) => e.id === id)!);
const asModel = (d: unknown): NativeModel => d as NativeModel;
const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-ccf-et-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ASSUME = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' };
const END = [
  { id: 'SAFE', name: 'Safe (example)', description: 'Nothing lost (example).', synthetic: true },
  { id: 'DEGRADED', name: 'Degraded (example)', description: 'One function lost (example).', synthetic: true },
  { id: 'LOSS', name: 'Loss of cooling (example)', description: 'Several lost (example).', synthetic: true },
];
const byFailures = (p: PathStep[]): string => (p.filter((s) => s.branch === 'fails').length === 0 ? 'SAFE' : p.filter((s) => s.branch === 'fails').length === 1 ? 'DEGRADED' : 'LOSS');
function treeDoc(model: GroupDoc, headings: { id: string; name: string; event: string }[], frequency = 0.5): Record<string, any> {
  return {
    schema: { id: 'sneed.event-tree', version: 1 },
    tree: { id: 'et', name: 'Test', created: '2026-10-25T00:00:00Z', updated: '2026-10-25T00:00:00Z' },
    fault_tree_model: { name: 'groups', model_hash: modelHash(asModel(model)) },
    initiating_event: { name: 'Transient (example)', description: 'An example.', frequency, unit: 'per-year' },
    headings,
    end_states: END,
    sequences: skeletonSequences(headings as never).map((s) => ({ path: s.path, end_state: byFailures(s.path) })),
    assumptions: ASSUME,
  };
}
const key = (path_: { heading: string; branch: string }[]): string => path_.map((s) => `${s.heading}:${s.branch}`).join(',');

describe('event trees on a model with common-cause groups', () => {
  it('hand numbers: two headings that are the two pumps of one group (Q = 0.1, beta = 0.1)', async () => {
    const model = cc('cc-and');
    const tree = treeDoc(model, [{ id: 'HA', name: 'Pump A', event: 'A' }, { id: 'HB', name: 'Pump B', event: 'B' }]);
    const out = await analyzeEventTreeBuiltin(JSON.stringify(tree), JSON.stringify(model), { runsDir: temp(), runId: 'et-ccf-hand-0001' });
    expect(out.kind).toBe('ran');
    if (out.kind !== 'ran') return;
    const r = out.record;
    expect(r).toMatchObject({ status: 'completed', completeness: 'complete', common_cause: { method: 'beta-factor', groups: [{ id: 'G', members: ['A', 'B'], beta: 0.1 }] } });
    const p = (k: string): number => r.sequences.find((s) => key(s.path) === k)!.probability;
    // A fails when its own part (0.09) or the common cause (0.01) occurs: P(A) = 1 - 0.91 x 0.99 = 0.0991, a little below Q = 0.1 (the usual approximation)
    // both: P(C) + (1 - P(C)) x P(I)^2 = 0.01 + 0.99 x 0.0081 = 0.018019; A alone: 0.0991 - 0.018019 = 0.081081; neither: 1 - 2 x 0.0991 + 0.018019 = 0.819819
    expect(p('HA:fails,HB:fails')).toBeCloseTo(0.018019, 12);
    expect(p('HA:fails,HB:works')).toBeCloseTo(0.081081, 12);
    expect(p('HA:works,HB:fails')).toBeCloseTo(0.081081, 12);
    expect(p('HA:works,HB:works')).toBeCloseTo(0.819819, 12);
    expect(r.total!.partition_error).toBeLessThan(1e-12);
    // the frequency of "both lost" is 0.5 x 0.018019, not the 0.5 x 0.01 of independent pumps
    expect(r.sequences.find((s) => key(s.path) === 'HA:fails,HB:fails')!.frequency).toBeCloseTo(0.0090095, 12);
    expect(r.input_hashes.model_hash).toBe(modelHash(asModel(model))); // the tree names the original model
    expect(r.caveats.join(' ')).toMatch(/common-cause groups/);
  });

  it('the labelled approximation counts the shared failure once, like the exact method does for shared events', async () => {
    const model = cc('cc-and');
    const tree = treeDoc(model, [{ id: 'HA', name: 'Pump A', event: 'A' }, { id: 'HB', name: 'Pump B', event: 'B' }]);
    const out = await analyzeEventTreeBuiltin(JSON.stringify(tree), JSON.stringify(model), { runsDir: temp(), runId: 'et-ccf-hand-0002', approximation: true });
    if (out.kind !== 'ran') throw new Error('refused');
    const both = out.record.sequences.find((s) => key(s.path) === 'HA:fails,HB:fails')!;
    expect(both.approximation!.probability).toBeCloseTo(0.018019, 12); // both failing, success conditions dropped: the same event
  });

  it('a model without groups has no common_cause block and no caveat about groups', async () => {
    const plain = { ...cc('cc-and') } as Record<string, unknown>;
    delete plain.common_cause_groups;
    plain.assumptions = { ...(plain.assumptions as object), independence: 'declared-independent' };
    const model = plain as unknown as GroupDoc;
    const tree = treeDoc(model, [{ id: 'HA', name: 'Pump A', event: 'A' }, { id: 'HB', name: 'Pump B', event: 'B' }]);
    const out = await analyzeEventTreeBuiltin(JSON.stringify(tree), JSON.stringify(model), { runsDir: temp(), runId: 'et-ccf-hand-0003' });
    if (out.kind !== 'ran') throw new Error('refused');
    expect(out.record.common_cause).toBeUndefined();
    expect(out.record.caveats.join(' ')).not.toMatch(/common-cause/);
    expect(out.record.sequences.find((s) => key(s.path) === 'HA:fails,HB:fails')!.probability).toBeCloseTo(0.01, 12);
  });

  it('60 random trees with groups: every sequence probability equals the exact enumeration of the plain tree', async () => {
    let usedGroup = 0;
    for (let seed = 4000; seed < 4060; seed++) {
      const model = randomGroupDoc(seed);
      const g0 = model.common_cause_groups![0]!;
      const others = model.events.filter((e) => !g0.members.includes(e.id)).map((e) => e.id);
      const heads = [g0.members[0]!, others[0] ?? g0.members[1]!, model.top].filter((v, i, a) => a.indexOf(v) === i).map((event, i) => ({ id: `H${i + 1}`, name: `Heading ${i + 1}`, event }));
      const tree = treeDoc(model, heads);
      const want = enumerateEventTree(groupsToPlain(model) as never, tree as never);
      const out = await analyzeEventTreeBuiltin(JSON.stringify(tree), JSON.stringify(model), { runsDir: temp(), runId: `et-ccf-rand-${seed}` });
      expect(out.kind, `seed ${seed}`).toBe('ran');
      if (out.kind !== 'ran') continue;
      expect(out.record.status, `seed ${seed}`).toBe('completed');
      for (const s of out.record.sequences) {
        expect(Math.abs(s.probability - want.probability.get(key(s.path))!.toNumber()), `seed ${seed} ${key(s.path)}`).toBeLessThanOrEqual(1e-12);
      }
      usedGroup++;
    }
    expect(usedGroup).toBe(60);
  });

  it('a heading that is a group member and the same heading with beta = 0 differ only through the group', async () => {
    const withGroup = cc('cc-and');
    const zero = { ...withGroup, common_cause_groups: [{ ...withGroup.common_cause_groups![0]!, beta: 0 }] } as GroupDoc;
    const headings = [{ id: 'HA', name: 'Pump A', event: 'A' }, { id: 'HB', name: 'Pump B', event: 'B' }];
    const run = async (m: GroupDoc, id: string) => {
      const out = await analyzeEventTreeBuiltin(JSON.stringify(treeDoc(m, headings)), JSON.stringify(m), { runsDir: temp(), runId: id });
      if (out.kind !== 'ran') throw new Error('refused');
      return out.record.sequences.find((s) => key(s.path) === 'HA:fails,HB:fails')!.probability;
    };
    expect(await run(zero, 'et-ccf-zero-0001')).toBeCloseTo(0.01, 15); // the independent value
    expect(await run(withGroup, 'et-ccf-zero-0002')).toBeCloseTo(0.018019, 12);
  });
});

describe('importance measures on a model with common-cause groups', () => {
  const close = (a: number | null, b: number | null, ctx: string): void => {
    if (a === null || b === null) return void expect(a, ctx).toBe(b);
    expect(Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-15, `${ctx}: ${a} vs ${b}`).toBe(true);
  };

  it('the table is for the events the groups are made of, and equals the exact enumeration of the plain tree', () => {
    for (let seed = 5000; seed < 5040; seed++) {
      const doc = randomGroupDoc(seed);
      const plain = groupsToPlain(doc);
      const r = importance(expandGroups(asModel(doc)));
      const P = enumerate(plain).probability.toNumber();
      close(r.top, P, `seed ${seed} top`);
      const safe = (id: string): string => id.replaceAll('.', '__');
      expect(r.rows.map((x) => safe(x.id)).sort(), `seed ${seed}`).toEqual(enumerate(plain).events);
      for (const row of r.rows) {
        const set = (p: number) => ({ ...plain, events: plain.events.map((e) => (e.id === safe(row.id) ? { ...e, probability: p } : e)) });
        const failed = enumerate(set(1)).probability.toNumber();
        const works = enumerate(set(0)).probability.toNumber();
        close(row.birnbaum, failed - works, `seed ${seed} ${row.id} IB`);
        close(row.raw, P > 0 ? failed / P : null, `seed ${seed} ${row.id} RAW`);
        close(row.fv, P > 0 ? (P - works) / P : null, `seed ${seed} ${row.id} FV`);
      }
    }
  });

  it('hand numbers: OR of two pumps in a group (Q = 0.1, beta = 0.1): the common cause matters most', () => {
    const r = importance(expandGroups(asModel(cc('cc-or'))));
    const row = (id: string) => r.rows.find((x) => x.id === id)!;
    expect(r.top).toBeCloseTo(0.180181, 12);
    // top = A OR B, A = I_A or C. Birnbaum of I_A: P(top | I_A fails) = 1, P(top | I_A works) = 1 - (1 - 0.09)(1 - 0.01) = 0.0991, so 0.9009.
    // Birnbaum of C: P(top | C fails) = 1, P(top | C works) = 1 - (1 - 0.09)^2 = 0.1719, so 0.8281: it matters when neither pump fails alone.
    expect(row('A.independent').birnbaum).toBeCloseTo(0.9009, 12);
    expect(row('G.CCF').birnbaum).toBeCloseTo(0.8281, 12);
    expect(row('G.CCF').probability).toBeCloseTo(0.01, 15);
    expect(row('A.independent').probability).toBeCloseTo(0.09, 15);
  });

  it('names for the events the groups add', () => {
    const names = derivedEventNames({ events: [{ id: 'A', name: 'Pump A' }, { id: 'B' }], common_cause_groups: [{ id: 'G', name: 'Pumps', members: ['A', 'B'] }] });
    expect(names.get('A.independent')).toBe('Pump A on its own');
    expect(names.get('B.independent')).toBe('B on its own');
    expect(names.get('G.CCF')).toBe('common cause of group Pumps');
    expect(derivedEventNames({ events: [{ id: 'A' }], common_cause_groups: [{ id: 'G', members: ['A'] }] }).get('G.CCF')).toBe('common cause of group G');
    expect(derivedEventNames({ events: [{ id: 'A' }] }).size).toBe(0);
  });

  it('over the API: the table, its names, the note on the assumptions and the original model\'s hash', async () => {
    const dir = temp();
    const s = await startServer({ projectDir: path.join(dir, 'm'), runsDir: path.join(dir, 'r'), runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(dir, 's') } }, 0);
    try {
      const model = { ...cc('cc-or'), events: cc('cc-or').events.map((e) => (e.id === 'A' ? { ...e, name: 'Pump A' } : e)), common_cause_groups: [{ ...cc('cc-or').common_cause_groups![0]!, name: 'Pumps' }] } as unknown as GroupDoc;
      const res = await fetch(`${s.url}/api/importance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sneed-request': '1' }, body: JSON.stringify({ text: JSON.stringify(model) }) });
      const json = (await res.json()) as { kind: string; model_hash: string; assumptions: string; events: { id: string; name?: string }[] };
      expect(json.kind).toBe('ok');
      expect(json.model_hash).toBe(modelHash(asModel(model)));
      expect(json.assumptions).toBe(`${IMPORTANCE_ASSUMPTIONS} ${IMPORTANCE_GROUPS_NOTE}`);
      const name = (id: string) => json.events.find((e) => e.id === id)?.name;
      expect(name('A.independent')).toBe('Pump A on its own');
      expect(name('G.CCF')).toBe('common cause of group Pumps');
      // a model without groups keeps its table and its assumptions exactly
      const plain = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../schema/vectors/good/pump3-shared.json'), 'utf8'));
      const res2 = await fetch(`${s.url}/api/importance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sneed-request': '1' }, body: JSON.stringify({ text: JSON.stringify(plain) }) });
      const json2 = (await res2.json()) as { kind: string; assumptions: string };
      expect(json2).toMatchObject({ kind: 'ok', assumptions: IMPORTANCE_ASSUMPTIONS });
      expect(existsSync(path.join(dir, 'r')) ? readdirSync(path.join(dir, 'r')) : []).toEqual([]); // importance writes nothing
    } finally {
      await s.close();
    }
  });
});
