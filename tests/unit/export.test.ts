import { describe, expect, it } from 'vitest';
import { ExportError, MAX_VOTE_TERMS, exportOpenPsa, xmlFloat } from '../../src/core/export.js';
import { evaluateExported, parseExported } from '../oracle/xmleval.js';
import { enumerate, topOccurs } from '../oracle/enumerate.js';
import { AND, OR, VOTE, mkDoc, randomDoc, ORACLE_MODELS } from '../oracle/models.js';
import { reachableEvents } from '../../src/core/bounds.js';
import type { NativeModel } from '../../src/core/model.js';

const model = (d: ReturnType<typeof mkDoc>): NativeModel => d as unknown as NativeModel;

describe('xmlFloat', () => {
  it('writes plain decimals, never exponents, without changing the value', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [1, '1'],
      [0.5, '0.5'],
      [0.021025, '0.021025'],
      [1e-7, '0.0000001'],
      [4.76837e-7, '0.000000476837'],
      [1.5e-10, '0.00000000015'],
      [0.5 ** 21, '0.000000476837158203125'],
    ];
    for (const [x, text] of cases) {
      expect(xmlFloat(x)).toBe(text);
      expect(xmlFloat(x)).not.toMatch(/e/i);
      expect(Number(xmlFloat(x))).toBe(x);
    }
  });
});

describe('export structure', () => {
  const pump3 = model(ORACLE_MODELS['pra-pump3-shared']!);

  it('matches a hand-written document for the shared-supply model', () => {
    const expected = `<?xml version="1.0"?>
<opsa-mef>
  <define-fault-tree name="SNEED">
    <define-gate name="PUMPS">
      <and>
        <basic-event name="P1"/>
        <basic-event name="P2"/>
      </and>
    </define-gate>
    <define-gate name="TOP">
      <or>
        <basic-event name="S"/>
        <gate name="PUMPS"/>
      </or>
    </define-gate>
    <define-basic-event name="P1">
      <float value="0.1"/>
    </define-basic-event>
    <define-basic-event name="P2">
      <float value="0.1"/>
    </define-basic-event>
    <define-basic-event name="S">
      <float value="0.05"/>
    </define-basic-event>
  </define-fault-tree>
</opsa-mef>
`;
    expect(exportOpenPsa(pump3).xml).toBe(expected);
  });

  it('is deterministic and independent of array order', () => {
    const shuffled = { ...pump3, events: [...pump3.events].reverse(), gates: [...pump3.gates].reverse() };
    expect(exportOpenPsa(shuffled).xml).toBe(exportOpenPsa(pump3).xml);
  });

  it('writes a basic-event top through a wrapper gate and picks a name that is free', () => {
    const one = exportOpenPsa(model(ORACLE_MODELS['pra-pump1']!));
    expect(one.mapping.wrapperGate).toBe('TOP');
    expect(one.xml).toContain('<define-gate name="TOP">');
    // an event already called TOP forces another wrapper name
    const clash = exportOpenPsa(model(mkDoc('TOP', { TOP: 0.1 }, [])));
    expect(clash.mapping.wrapperGate).toBe('TOP_1');
    expect(clash.xml).toContain('<basic-event name="TOP"/>');
  });

  it('collapses duplicate inputs and keeps identity: A AND A is just A', () => {
    const e = exportOpenPsa(model(ORACLE_MODELS['pra-aa']!));
    expect(e.xml).not.toContain('<and>');
    expect(e.mapping.collapsed).toEqual({ TOP: 'A' });
    // the native gate TOP collapsed away but still owns the name, so the wrapper must not reuse it
    expect(e.mapping.wrapperGate).toBe('TOP_1');
    expect(e.mapping.top).toBe('TOP_1');
    expect(e.mapping.events).toEqual(['A']);
  });

  it('deduplicates repeated inputs without losing the other inputs', () => {
    const e = exportOpenPsa(model(mkDoc('TOP', { A: 0.1, B: 0.2 }, [OR('TOP', ['A', 'B', 'A'])])));
    expect((e.xml.match(/<basic-event name="A"\/>/g) ?? []).length).toBe(1);
    expect(e.xml).toContain('<basic-event name="B"/>');
  });

  it('replaces a collapsed gate by its single reference wherever it is used', () => {
    const m = model(mkDoc('TOP', { A: 0.1, B: 0.2 }, [OR('TOP', ['G1', 'B']), AND('G1', ['A', 'A'])]));
    const e = exportOpenPsa(m);
    expect(e.mapping.collapsed).toEqual({ G1: 'A' });
    expect(e.mapping.gates).toEqual(['TOP']);
    expect(e.xml).not.toContain('G1');
  });

  it('exports only what the top reaches', () => {
    const base = model(ORACLE_MODELS['pra-pump3-shared']!);
    const padded = model(mkDoc('TOP', { P1: 0.1, P2: 0.1, S: 0.05, UNUSED: 0.9 }, [...base.gates, OR('ORPHAN', ['UNUSED', 'S'])]));
    const e = exportOpenPsa(padded);
    expect(e.xml).toBe(exportOpenPsa(base).xml);
  });

  it('writes a native voting gate as atleast', () => {
    const e = exportOpenPsa(model(mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'C'], 2)])));
    expect(e.xml).toContain('<atleast min="2">');
    expect(e.mapping.expandedVotes).toEqual([]);
  });

  it('rewrites a voting gate whose inputs resolve to the same reference as OR of ANDs', () => {
    // G1 = A AND A is just A, so V counts A twice: 2 of [A, A, B] is true when A fails, or when A and B fail
    const m = model(mkDoc('V', { A: 0.1, B: 0.2 }, [VOTE('V', ['G1', 'A', 'B'], 2), AND('G1', ['A', 'A'])]));
    const e = exportOpenPsa(m);
    expect(e.mapping.expandedVotes).toEqual(['V']);
    expect(e.xml).not.toContain('<atleast');
    const parsed = parseExported(e.xml);
    for (const failed of [[], ['A'], ['B'], ['A', 'B']]) {
      expect(evaluateExported(parsed, new Set(failed)), failed.join('+')).toBe(topOccurs(m, new Set(failed)));
    }
  });

  describe('voting modes', () => {
    const pureVote = model(mkDoc('V', { A: 0.1, B: 0.1, C: 0.1 }, [VOTE('V', ['A', 'B', 'C'], 2)]));
    const gateVote = model(mkDoc('TOP', { A: 0.1, B: 0.2, C: 0.3 }, [VOTE('TOP', ['C', 'A', 'G0', 'B'], 2), OR('G0', ['A', 'C'])]));

    it('auto keeps atleast only when every input is a distinct basic event', () => {
      expect(exportOpenPsa(pureVote).xml).toContain('<atleast min="2">');
      expect(exportOpenPsa(gateVote).xml).not.toContain('<atleast');
      expect(exportOpenPsa(gateVote).mapping.expandedVotes).toEqual(['TOP']);
    });

    it('expand always rewrites and native never does (except when forced by duplicate references)', () => {
      expect(exportOpenPsa(pureVote, { voting: 'expand' }).xml).not.toContain('<atleast');
      expect(exportOpenPsa(gateVote, { voting: 'native' }).xml).toContain('<atleast min="2">');
    });

    it('all three modes mean the same logic (checked on every failure state)', () => {
      for (const m of [pureVote, gateVote]) {
        const events = reachableEvents(m);
        for (const voting of ['native', 'expand', 'auto'] as const) {
          const parsed = parseExported(exportOpenPsa(m, { voting }).xml);
          for (let mask = 0; mask < 1 << events.length; mask++) {
            const failed = new Set(events.filter((_, i) => (mask >> i) & 1));
            expect(evaluateExported(parsed, failed), `${voting} mask ${mask}`).toBe(topOccurs(m as never, failed));
          }
        }
      }
    });

    it('refuses an expansion past the term limit with a typed error naming the gate', () => {
      const ev = Array.from({ length: 13 }, (_, i) => `E${i}`);
      const big = model(mkDoc('V', Object.fromEntries(ev.map((e) => [e, 0.1])), [VOTE('V', [...ev, 'G'], 7), OR('G', ['E0', 'E1'])]));
      expect(() => exportOpenPsa(big)).toThrow(ExportError);
      try {
        exportOpenPsa(big);
      } catch (e) {
        expect((e as ExportError).code).toBe('E_EXPORT_LIMIT');
        expect((e as ExportError).ids).toEqual(['V']);
      }
      // just under the limit still exports: 2000 = C(n, k) boundary is checked, not guessed
      expect(MAX_VOTE_TERMS).toBe(2000);
      const ok = model(mkDoc('V', Object.fromEntries(ev.map((e) => [e, 0.1])), [VOTE('V', [...ev.slice(0, 11), 'G'], 5), OR('G', ['E0', 'E1'])]));
      expect(() => exportOpenPsa(ok)).not.toThrow(); // C(12,5) = 792
    });
  });

  it('only ever writes identifiers the engine accepts and never writes an exponent', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { xml } = exportOpenPsa(model(randomDoc(seed)));
      for (const m of xml.matchAll(/name="([^"]*)"/g)) {
        if (m[1] !== 'SNEED') expect(m[1], `seed ${seed}`).toMatch(/^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/);
      }
      const values = [...xml.matchAll(/float value="([^"]*)"/g)].map((m) => m[1]!);
      expect(values.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const v of values) expect(v, `seed ${seed}`).toMatch(/^\d+(\.\d+)?$/);
    }
  });
});

describe('export semantics (exported XML evaluated independently, without the engine)', () => {
  function check(doc: ReturnType<typeof mkDoc>, ctx: string): void {
    const m = model(doc);
    const { xml, mapping } = exportOpenPsa(m);
    const parsed = parseExported(xml);
    const events = reachableEvents(m);
    expect([...parsed.events.keys()].sort(), `${ctx} events`).toEqual(events);
    expect([...parsed.events.keys()].sort(), `${ctx} mapping events`).toEqual(mapping.events);
    const probs = new Map(m.events.map((e) => [e.id, e.probability]));
    for (const [id, text] of parsed.events) expect(Number(text), `${ctx} probability of ${id}`).toBe(probs.get(id));
    for (let mask = 0; mask < 1 << events.length; mask++) {
      const failed = new Set(events.filter((_, i) => (mask >> i) & 1));
      expect(evaluateExported(parsed, failed), `${ctx} mask ${mask}`).toBe(topOccurs(doc, failed));
    }
  }

  it('every frozen oracle model exports to logic equal to the native model', () => {
    for (const [id, doc] of Object.entries(ORACLE_MODELS)) check(doc, id);
  });

  it('300 seeded random trees export to equivalent logic', () => {
    let expanded = 0;
    let collapsedSome = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const doc = randomDoc(seed);
      check(doc, `seed ${seed}`);
      const { mapping } = exportOpenPsa(model(doc));
      if (mapping.expandedVotes.length) expanded++;
      if (Object.keys(mapping.collapsed).length) collapsedSome++;
    }
    // the generator must reach the rewrite paths, or the comparison above proves nothing about them
    expect(collapsedSome).toBeGreaterThanOrEqual(20);
    expect(expanded).toBeGreaterThanOrEqual(1);
  });

  it('larger random trees too', () => {
    for (let seed = 1001; seed < 1021; seed++) check(randomDoc(seed, { events: 11 + (seed % 4), gates: 10 + (seed % 7) }), `large seed ${seed}`);
  });

  it('the oracle and the exported logic give the same cut sets', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const doc = randomDoc(seed);
      const r = enumerate(doc);
      const parsed = parseExported(exportOpenPsa(model(doc)).xml);
      for (const c of r.cutSets) expect(evaluateExported(parsed, new Set(c)), `seed ${seed}`).toBe(true);
    }
  });
});

describe('an id of __proto__ in the export', () => {
  it('a gate called __proto__ that collapses to its one input is an ordinary entry of the collapse record, not lost', () => {
    const e = exportOpenPsa(model(mkDoc('TOP', { A: 0.1, B: 0.2 }, [OR('__proto__', ['A', 'A']), AND('TOP', ['__proto__', 'B'])])));
    expect(Object.keys(e.mapping.collapsed)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(e.mapping.collapsed, '__proto__')?.value).toBe('A');
    // and the record survives being written out and read back
    expect(Object.keys(JSON.parse(JSON.stringify(e.mapping.collapsed)))).toContain('__proto__');
  });
});
