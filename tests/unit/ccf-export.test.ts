import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { expandGroups } from '../../src/core/ccf.js';
import { exportOpenPsa } from '../../src/core/export.js';
import { modelHash } from '../../src/core/canonical.js';
import { reachableEvents } from '../../src/core/bounds.js';
import { assess } from '../../src/core/result.js';
import type { NativeModel } from '../../src/core/model.js';
import { Q, parseDecimal } from '../oracle/rational.js';
import { evaluateExported, parseExported } from '../oracle/xmleval.js';
import { makeReport } from '../oracle/reportgen.js';
import { AND, OR, mkDoc } from '../oracle/models.js';
import { enumerateGroups, frozenCaseDoc, randomGroupDoc, type FrozenCase, type GroupDoc } from '../oracle/groups.js';

// Plan 15, stage C3: a model with common-cause groups is written for SCRAM as its expansion. SCRAM refuses a dot in a name, so the
// events the expansion adds get a name without one, and the analysis translates them back, so both engines report the same names.
// There is no SCRAM in the unit tests: the XML is evaluated independently (tests/oracle/xmleval.ts) and the report is a fabricated one.

const frozen = JSON.parse(readFileSync(path.join(import.meta.dirname, '../oracles-common-cause.json'), 'utf8')) as FrozenCase[];
const byId = (id: string): FrozenCase => frozen.find((e) => e.id === id)!;
const asModel = (d: unknown): NativeModel => d as NativeModel;
const sortSets = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

/** The exact probability of the exported XML, summed over every state of its events, from the probabilities as the XML prints them. */
function xmlProbability(xml: string): Q {
  const parsed = parseExported(xml);
  const ids = [...parsed.events.keys()].sort();
  const p = ids.map((id) => {
    const d = parseDecimal(Number(parsed.events.get(id)));
    return Q.make(d.a, 10n ** BigInt(d.s));
  });
  let total = Q.ZERO;
  for (let mask = 0; mask < 1 << ids.length; mask++) {
    if (!evaluateExported(parsed, new Set(ids.filter((_, i) => (mask >> i) & 1)))) continue;
    let term = Q.ONE;
    ids.forEach((_, i) => (term = term.mul((mask >> i) & 1 ? p[i]! : Q.ONE.sub(p[i]!))));
    total = total.add(term);
  }
  return total;
}

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-ccf-export-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the export of a model with common-cause groups', () => {
  it('writes the expansion with names SCRAM accepts, and says how to translate them back', () => {
    const e = exportOpenPsa(asModel(frozenCaseDoc(byId('cc-and'))));
    expect(e.xml).not.toMatch(/name="[^"]*\.[^"]*"/); // no dot in any name
    expect(e.mapping.renamed).toEqual({ A__independent: 'A.independent', B__independent: 'B.independent', G__CCF: 'G.CCF' });
    expect(e.mapping.events).toEqual(['A__independent', 'B__independent', 'G__CCF']);
    const parsed = parseExported(e.xml);
    expect(Number(parsed.events.get('G__CCF'))).toBe(0.01);
    expect(Number(parsed.events.get('A__independent'))).toBe(0.09);
  });

  it('a model without groups is exported exactly as before, with no translation table', () => {
    const e = exportOpenPsa(asModel(mkDoc('TOP', { A: 0.1, B: 0.2 }, [AND('TOP', ['A', 'B'])])));
    expect(e.mapping.renamed).toBeUndefined();
    expect(e.xml).not.toContain('__');
  });

  it('exporting the model and exporting its expansion give the same file', () => {
    const doc = asModel(frozenCaseDoc(byId('cc-vote')));
    expect(exportOpenPsa(expandGroups(doc)).xml).toBe(exportOpenPsa(doc).xml);
  });

  it('a name that is already taken is not reused: the translated name gets a number', () => {
    const doc = frozenCaseDoc(byId('cc-and')) as GroupDoc & { events: { id: string; probability: number }[]; gates: { id: string; type: 'or'; inputs: string[] }[] };
    const withClash = { ...doc, events: [...doc.events, { id: 'G__CCF', probability: 0.5 }], gates: [{ id: 'TOP', type: 'or' as const, inputs: ['A', 'B', 'G__CCF'] }] };
    const e = exportOpenPsa(asModel(withClash));
    expect(e.mapping.renamed).toMatchObject({ G__CCF_1: 'G.CCF' });
    expect(e.mapping.renamed!['G__CCF']).toBeUndefined(); // the user's own event keeps its name
    expect(Number(parseExported(e.xml).events.get('G__CCF'))).toBe(0.5);
  });

  for (const e of frozen) {
    it(`${e.id}: the exported XML, evaluated without the engine, has the frozen probability`, () => {
      const xml = exportOpenPsa(asModel(frozenCaseDoc(e))).xml;
      expect(Math.abs(xmlProbability(xml).toNumber() - e.expected_probability)).toBeLessThanOrEqual(e.tolerance.absolute);
    });
  }

  it('random trees with groups: the exported XML has the exact probability of the group definition', () => {
    for (let seed = 2000; seed < 2060; seed++) {
      const doc = randomGroupDoc(seed);
      const want = enumerateGroups(doc).probability.toNumber();
      const xml = exportOpenPsa(asModel(doc)).xml;
      expect(Math.abs(xmlProbability(xml).toNumber() - want), `seed ${seed}`).toBeLessThanOrEqual(1e-12);
    }
  });
});

describe('a report from the engine is read back in the model\'s names', () => {
  const model = (id: string): { doc: NativeModel; expanded: NativeModel; xml: ReturnType<typeof exportOpenPsa> } => {
    const doc = asModel(frozenCaseDoc(byId(id)));
    return { doc, expanded: expandGroups(doc), xml: exportOpenPsa(doc) };
  };
  const run = (id: string, report: string, withRename = true) => {
    const { expanded, xml } = model(id);
    const events = reachableEvents(expanded);
    return assess({
      model: expanded,
      settings: { method: 'exact', limitOrder: Math.max(1, events.length) },
      engine: { name: 'SCRAM', version: '0.16.2', sha256: 'abc' },
      expectedVersion: '0.16.2',
      outcome: { exit: 0, timedOut: false, cancelled: false, stderr: '' },
      reportText: report,
      hashes: { model_hash: 'm', document_hash: 'd', exported_input_hash: 'x' },
      exportedEvents: xml.mapping.events,
      ...(withRename && xml.mapping.renamed ? { renameEvents: xml.mapping.renamed } : {}),
    });
  };
  // what SCRAM would print for cc-and: the names it was given
  const scramReport = makeReport({
    probability: '0.018019',
    limit: 3,
    products: [
      { events: ['G__CCF'], probability: '0.01' },
      { events: ['A__independent', 'B__independent'], probability: '0.0081' },
    ],
  });

  it('the cut sets of the record carry the dotted names, and the result is complete', () => {
    const r = run('cc-and', scramReport);
    expect(r).toMatchObject({ status: 'completed', completeness: 'complete', reasons: [] });
    expect(sortSets(r.minimal_cut_sets.map((c) => c.events))).toEqual(sortSets(byId('cc-and').expected_cut_sets!));
    expect(r.top_event_probability).toBeCloseTo(0.018019, 12);
  });

  it('without the translation the same report is not accepted: an event the model does not have', () => {
    const r = run('cc-and', scramReport, false);
    expect(r.status).toBe('failed');
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe('the SCRAM path with common-cause groups (no SCRAM here: the engine is not found, the input is what counts)', () => {
  it('writes the expansion as the engine\'s input, records the groups, and keeps the original model\'s hash', async () => {
    const runsDir = temp();
    const text = JSON.stringify(frozenCaseDoc(byId('cc-or')));
    const out = await analyze(text, { runsDir, runId: 'ccf-scram-0001', engine: { distro: 'none', binary: '/none', libs: '', expectedVersion: '0.16.2', expectedSha256: '0' } });
    expect(out.kind).toBe('ran'); // refused is what the stage C1 stop gave; now the run is made, and ends as a failure because no engine is there
    if (out.kind !== 'ran') return;
    expect(out.record.status).toBe('failed');
    expect(out.record.common_cause).toMatchObject({ method: 'beta-factor', groups: [{ id: 'G', members: ['A', 'B'], beta: 0.1 }] });
    expect(out.record.input_hashes.model_hash).toBe(modelHash(JSON.parse(text)));
    expect(out.record.assumptions).toMatchObject({ independence: 'beta-factor-groups' });
    expect(out.record.settings.limitOrder).toBe(3); // the engine is told the order of the expansion's events (A.independent, B.independent, G.CCF), not the model's two
    const xml = readFileSync(path.join(out.runDir, 'inputs', 'model.xml'), 'utf8');
    expect(xml).toContain('G__CCF');
    expect(xml).not.toMatch(/name="[^"]*\.[^"]*"/);
    expect(readFileSync(path.join(out.runDir, 'native', 'model.json'), 'utf8')).toBe(text);
    const settings = JSON.parse(readFileSync(path.join(out.runDir, 'inputs', 'settings.json'), 'utf8')) as { export_mapping: { renamed: Record<string, string> } };
    expect(settings.export_mapping.renamed).toEqual({ A__independent: 'A.independent', B__independent: 'B.independent', G__CCF: 'G.CCF' });
    expect(existsSync(path.join(out.runDir, 'results.json'))).toBe(true);
  });

  it('a model without groups leaves no common_cause block in its record', async () => {
    const runsDir = temp();
    const out = await analyze(JSON.stringify(mkDoc('TOP', { A: 0.1, B: 0.2 }, [OR('TOP', ['A', 'B'])])), { runsDir, runId: 'ccf-scram-0002', engine: { distro: 'none', binary: '/none', libs: '', expectedVersion: '0.16.2', expectedSha256: '0' } });
    if (out.kind !== 'ran') throw new Error('refused');
    expect(out.record.common_cause).toBeUndefined();
  });
});
