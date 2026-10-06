import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { importOpenPsa, MAX_IMPORT_BYTES, type ImportResult } from '../../src/core/import.js';
import { exportOpenPsa } from '../../src/core/export.js';
import { validateModel } from '../../src/core/validate.js';
import type { NativeModel } from '../../src/core/model.js';
import { enumerate } from '../oracle/enumerate.js';
import { ORACLE_MODELS, randomDoc, type Doc } from '../oracle/models.js';

const NOW = '2026-10-06T00:00:00Z';
const imp = (xml: string): ImportResult => importOpenPsa(xml, { now: NOW });
const ok = (xml: string): Extract<ImportResult, { ok: true }> => {
  const r = imp(xml);
  if (!r.ok) throw new Error('refused: ' + JSON.stringify(r.errors));
  return r;
};
const bad = (xml: string): Extract<ImportResult, { ok: false }> => {
  const r = imp(xml);
  if (r.ok) throw new Error('accepted, expected a refusal');
  return r;
};
const first = (xml: string) => bad(xml).errors[0]!;
const sortSets = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

/** A well-formed file around the given definitions. */
const file = (body: string, tree = 'FT'): string => `<?xml version="1.0"?>\n<opsa-mef>\n  <define-fault-tree name="${tree}">\n${body}\n  </define-fault-tree>\n</opsa-mef>\n`;
const be = (n: string, p: string): string => `    <define-basic-event name="${n}"><float value="${p}"/></define-basic-event>`;

describe('round trip with the exporter: what we write, we read back as the same model', () => {
  const same = (doc: Doc, ctx: string): void => {
    const model = doc as unknown as NativeModel;
    const xml = exportOpenPsa(model).xml;
    const r = imp(xml);
    expect(r.ok, `${ctx}: ${JSON.stringify(!r.ok && r.errors)}`).toBe(true);
    if (!r.ok) return;
    expect(validateModel(r.doc).valid, ctx).toBe(true);
    // the structure may differ (wrapper gates, collapsed duplicates, expanded votes), the logic may not
    const a = enumerate(doc);
    const b = enumerate(r.doc as unknown as Doc);
    expect(b.probability.toNumber(), `${ctx} probability`).toBe(a.probability.toNumber());
    expect(sortSets(b.cutSets), `${ctx} cut sets`).toEqual(sortSets(a.cutSets));
  };

  it('every frozen oracle model', () => {
    for (const [id, doc] of Object.entries(ORACLE_MODELS)) same(doc, id);
  });

  it('a basic-event top (the exporter writes a wrapper gate) comes back as a basic-event top', () => {
    const r = ok(exportOpenPsa(ORACLE_MODELS['pra-pump1'] as unknown as NativeModel).xml);
    expect((r.doc as { top: string }).top).toBe('P');
    expect((r.doc as { gates: unknown[] }).gates).toEqual([]);
    expect(r.notes.some((n) => n.kind === 'pass-through')).toBe(true);
  });

  it('1500 random trees (repeated references, K-of-N written both ways, probabilities 0 and 1)', () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const doc = randomDoc(seed);
      for (const voting of ['native', 'expand'] as const) {
        const model = doc as unknown as NativeModel;
        let xml: string;
        try {
          xml = exportOpenPsa(model, { voting }).xml;
        } catch {
          continue; // an expansion past the export limit
        }
        const r = imp(xml);
        expect(r.ok, `seed ${seed} ${voting}: ${JSON.stringify(!r.ok && r.errors)}`).toBe(true);
        if (!r.ok) continue;
        const a = enumerate(doc);
        const b = enumerate(r.doc as unknown as Doc);
        expect(b.probability.toNumber(), `seed ${seed} ${voting}`).toBe(a.probability.toNumber());
        expect(sortSets(b.cutSets), `seed ${seed} ${voting}`).toEqual(sortSets(a.cutSets));
      }
    }
  });
});

describe('a typical SCRAM-style file', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- two pumps and a shared supply -->
<opsa-mef xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <define-fault-tree name="Cooling">
    <define-gate name="TOP">
      <and>
        <gate name="LEFT"/>
        <gate name="RIGHT"/>
      </and>
    </define-gate>
    <define-gate name="LEFT"><or><basic-event name="P1"/><basic-event name="S"/></or></define-gate>
    <define-gate name="RIGHT"><or><basic-event name="P2"/><basic-event name="S"/></or></define-gate>
  </define-fault-tree>
  <model-data>
    <define-basic-event name="P1"><float value="0.1"/></define-basic-event>
    <define-basic-event name="P2"><float value="0.1"/></define-basic-event>
    <define-basic-event name="S"><float value="0.05"/></define-basic-event>
  </model-data>
</opsa-mef>
`;
  it('imports with basic events in <model-data>, reads the name, and equals the hand value 0.0595', () => {
    const r = ok(xml);
    const doc = r.doc as { top: string; model: { name: string }; events: unknown[]; gates: unknown[] };
    expect(doc.top).toBe('TOP');
    expect(doc.model.name).toBe('Cooling');
    expect(doc.events).toHaveLength(3);
    expect(enumerate(r.doc as unknown as Doc).probability.toNumber()).toBeCloseTo(0.0595, 12);
    expect(r.sourceSha256).toBe(createHash('sha256').update(xml, 'utf8').digest('hex'));
    expect(r.importer).toBe('sneed-import-1');
  });

  it('a nested formula becomes a generated gate with a name that cannot collide, and says so', () => {
    const r = ok(file(`${be('A', '0.1')}\n${be('B', '0.2')}\n${be('C', '0.3')}\n${be('TOP_1', '0.5')}
    <define-gate name="TOP"><or><and><basic-event name="A"/><basic-event name="B"/></and><basic-event name="C"/><basic-event name="TOP_1"/></or></define-gate>`));
    const gates = (r.doc as { gates: { id: string; type: string; inputs: string[] }[] }).gates;
    const gen = gates.find((g) => g.type === 'and')!;
    expect(gen.id).toBe('TOP_2'); // TOP_1 is taken by an event
    expect(gates.find((g) => g.id === 'TOP')!.inputs).toContain('TOP_2');
    expect(r.notes.find((n) => n.kind === 'generated-gate')).toMatchObject({ line: 8 });
  });

  it('pass-through gates are collapsed, including chains', () => {
    const r = ok(file(`${be('A', '0.1')}\n${be('B', '0.2')}
    <define-gate name="G1"><basic-event name="A"/></define-gate>
    <define-gate name="G2"><gate name="G1"/></define-gate>
    <define-gate name="TOP"><or><gate name="G2"/><basic-event name="B"/></or></define-gate>`));
    expect((r.doc as { gates: { inputs: string[] }[] }).gates).toEqual([{ id: 'TOP', type: 'or', inputs: ['A', 'B'] }]);
    expect(r.notes.filter((n) => n.kind === 'pass-through')).toHaveLength(2);
  });

  it('a single basic event with no gate is its own top; an unused event is a warning, not an error', () => {
    expect((ok(file(be('P', '0.1'))).doc as { top: string }).top).toBe('P');
    const r = ok(file(`${be('A', '0.1')}\n${be('B', '0.2')}\n${be('UNUSED', '0.3')}\n<define-gate name="TOP"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>`));
    expect(r.notes.some((n) => n.kind === 'warning')).toBe(true);
  });

  it('the generic <event> reference is accepted, and numbers in the forms XML allows', () => {
    const r = ok(file(`${be('A', '1e-3')}\n${be('B', '.5')}\n${be('C', '+0.25')}\n<define-gate name="TOP"><or><event name="A"/><event name="B"/><event name="C"/></or></define-gate>`));
    expect((r.doc as { events: { probability: number }[] }).events.map((e) => e.probability)).toEqual([0.001, 0.5, 0.25]);
  });

  it('K-of-N with atleast', () => {
    const r = ok(file(`${be('A', '0.1')}\n${be('B', '0.1')}\n${be('C', '0.1')}\n<define-gate name="V"><atleast min="2"><basic-event name="A"/><basic-event name="B"/><basic-event name="C"/></atleast></define-gate>`));
    expect(enumerate(r.doc as unknown as Doc).probability.toNumber()).toBeCloseTo(0.028, 12);
  });

  it('the same file always gives the same result, byte for byte', () => {
    expect(ok(xml).text).toBe(ok(xml).text);
  });
});

describe('what is outside the subset is refused, naming the construct and the line', () => {
  const A = be('A', '0.1');
  const B = be('B', '0.2');
  const cases: [string, string, string, number][] = [
    ['an event tree', `<opsa-mef><define-event-tree name="E"/><define-fault-tree name="F"/></opsa-mef>`, '<define-event-tree>', 1],
    ['a common-cause group', file(`${A}\n<define-CCF-group name="G" model="beta-factor"/>`), '<define-CCF-group>', 5],
    ['a house event', file(`${A}\n<define-house-event name="H"><constant value="true"/></define-house-event>`), '<define-house-event>', 5],
    ['a parameter', file(`${A}\n<define-parameter name="P"><float value="1"/></define-parameter>`), '<define-parameter>', 5],
    ['a label', file(`${A}\n<label>text</label>`), '<label>', 5],
    ['not', file(`${A}\n${B}\n<define-gate name="T"><not><basic-event name="A"/></not></define-gate>`), '<not>', 6],
    ['xor', file(`${A}\n${B}\n<define-gate name="T"><xor><basic-event name="A"/><basic-event name="B"/></xor></define-gate>`), '<xor>', 6],
    ['nand', file(`${A}\n${B}\n<define-gate name="T"><nand><basic-event name="A"/><basic-event name="B"/></nand></define-gate>`), '<nand>', 6],
    ['an exponential probability', file(`<define-basic-event name="A"><exponential><float value="0.1"/><float value="8760"/></exponential></define-basic-event>`), '<exponential>', 4],
    ['a parameter reference as a probability', file(`<define-basic-event name="A"><parameter name="X"/></define-basic-event>`), '<parameter>', 4],
    ['a role attribute on a gate', file(`${A}\n${B}\n<define-gate name="T" role="private"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>`), 'attribute role', 6],
    ['an attribute on a connective', file(`${A}\n${B}\n<define-gate name="T"><or foo="1"><basic-event name="A"/><basic-event name="B"/></or></define-gate>`), 'attribute foo', 6],
    ['a root that is not opsa-mef', `<html><body/></html>`, '<html>', 1],
    ['a second fault tree', `<opsa-mef><define-fault-tree name="A"/><define-fault-tree name="B"/></opsa-mef>`, 'a second <define-fault-tree>', 1],
    ['a gate in model-data', `<opsa-mef><define-fault-tree name="A"/><model-data><define-gate name="G"><or/></define-gate></model-data></opsa-mef>`, '<define-gate>', 1],
    ['text inside an element', file(`${A}\n<define-gate name="T">hello</define-gate>`), 'text content', 5],
    ['a gate with two formulas', file(`${A}\n${B}\n<define-gate name="T"><basic-event name="A"/><basic-event name="B"/></define-gate>`), '<define-gate>', 6],
  ];
  for (const [what, xml, construct, line] of cases) {
    it(what, () => {
      const r = bad(xml);
      const e = r.errors.find((x) => x.code === 'E_UNSUPPORTED');
      expect(e, JSON.stringify(r.errors)).toBeDefined();
      expect(e!.construct).toBe(construct);
      expect(e!.line).toBe(line);
      expect(e!.message).toMatch(/outside the supported subset|must hold exactly one formula|not <opsa-mef>/);
    });
  }

  it('several unreferenced gates: the top is ambiguous and they are listed with their lines', () => {
    const e = first(file(`${A}\n${B}\n<define-gate name="T1"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>\n<define-gate name="T2"><and><basic-event name="A"/><basic-event name="B"/></and></define-gate>`));
    expect(e).toMatchObject({ code: 'E_UNSUPPORTED', construct: 'several top gates' });
    expect(e.message).toMatch(/T1 at line 6/);
    expect(e.message).toMatch(/T2 at line 7/);
  });

  it('every refusal in one file is reported (up to a bound), not only the first', () => {
    const r = bad(file(`${A}\n<define-house-event name="H"/>\n<define-parameter name="P"/>\n<label/>`));
    expect(r.errors.filter((e) => e.code === 'E_UNSUPPORTED').map((e) => e.line)).toEqual([5, 6, 7]);
    const many = bad(file(Array.from({ length: 200 }, (_, i) => `<define-house-event name="H${i}"/>`).join('\n')));
    expect(many.errors).toHaveLength(50);
  });
});

describe('names, numbers and references are checked with the line of the problem', () => {
  const A = be('A', '0.1');
  it.each([
    ['a name starting with a digit', file(be('1A', '0.1')), 'E_ID_FORMAT', 4],
    ['a name with a dot', file(be('A.B', '0.1')), 'E_ID_FORMAT', 4],
    ['a name with a space', file(be('A B', '0.1')), 'E_ID_FORMAT', 4],
    ['a name longer than 64 characters', file(be('A'.repeat(65), '0.1')), 'E_ID_FORMAT', 4],
    ['an event and a gate with one name', file(`${A}\n<define-gate name="A"><or><basic-event name="A"/><basic-event name="A"/></or></define-gate>`), 'E_DUP_ID', 5],
    ['the same event twice', file(`${A}\n${A}`), 'E_DUP_ID', 5],
    ['a probability above 1', file(be('A', '1.5')), 'E_PROB_RANGE', 4],
    ['a negative probability', file(be('A', '-0.1')), 'E_PROB_RANGE', 4],
    ['a probability that is not a number', file(be('A', 'abc')), 'E_PROB_RANGE', 4],
    ['a probability that is NaN', file(be('A', 'NaN')), 'E_PROB_RANGE', 4],
    ['a probability that is infinity', file(be('A', 'Infinity')), 'E_PROB_RANGE', 4],
    ['a probability in hexadecimal', file(be('A', '0x1')), 'E_PROB_RANGE', 4],
    ['a basic event with no probability', file(`<define-basic-event name="A"/>`), 'E_PROB_RANGE', 4],
    ['a reference to nothing', file(`${A}\n<define-gate name="T"><or><basic-event name="A"/><basic-event name="NOPE"/></or></define-gate>`), 'E_MISSING_REF', 5],
    ['a gate used as a basic event', file(`${A}\n${be('B', '0.1')}\n<define-gate name="G"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>\n<define-gate name="T"><or><basic-event name="G"/><basic-event name="A"/></or></define-gate>`), 'E_MISSING_REF', 7],
    ['an AND with one argument', file(`${A}\n<define-gate name="T"><and><basic-event name="A"/></and></define-gate>`), 'E_GATE_ARITY', 5],
    ['atleast without an integer min', file(`${A}\n${be('B', '0.1')}\n${be('C', '0.1')}\n<define-gate name="T"><atleast min="x"><basic-event name="A"/><basic-event name="B"/><basic-event name="C"/></atleast></define-gate>`), 'E_VOTE_RANGE', 7],
    ['atleast with min equal to the number of arguments', file(`${A}\n${be('B', '0.1')}\n${be('C', '0.1')}\n<define-gate name="T"><atleast min="3"><basic-event name="A"/><basic-event name="B"/><basic-event name="C"/></atleast></define-gate>`), 'E_VOTE_RANGE', 7],
    ['atleast with a repeated argument', file(`${A}\n${be('B', '0.1')}\n<define-gate name="T"><atleast min="2"><basic-event name="A"/><basic-event name="A"/><basic-event name="B"/></atleast></define-gate>`), 'E_VOTE_DUP', 6],
    ['gates that refer to each other', file(`${A}\n<define-gate name="G1"><or><gate name="G2"/><basic-event name="A"/></or></define-gate>\n<define-gate name="G2"><or><gate name="G1"/><basic-event name="A"/></or></define-gate>`), 'E_NO_TOP', 3],
    ['pass-through gates that refer to each other', file(`${A}\n<define-gate name="G1"><gate name="G2"/></define-gate>\n<define-gate name="G2"><gate name="G1"/></define-gate>\n<define-gate name="T"><or><gate name="G1"/><basic-event name="A"/></or></define-gate>`), 'E_CYCLE', 6],
    ['no gates and several events', file(`${A}\n${be('B', '0.1')}`), 'E_NO_TOP', 3],
  ] as const)('%s', (_what, xml, code, line) => {
    const e = bad(xml).errors.find((x) => x.code === code);
    expect(e, JSON.stringify(bad(xml).errors)).toBeDefined();
    expect(e!.line).toBe(line);
  });

  it('a cycle between ordinary gates is named by the validator, with the line of a gate in it', () => {
    const r = bad(file(`${A}\n${be('B', '0.1')}\n<define-gate name="G1"><or><gate name="G2"/><basic-event name="A"/></or></define-gate>\n<define-gate name="G2"><or><gate name="G1"/><basic-event name="B"/></or></define-gate>\n<define-gate name="T"><or><gate name="G1"/><basic-event name="A"/></or></define-gate>`));
    const e = r.errors.find((x) => x.code === 'E_CYCLE');
    expect(e).toBeDefined();
    expect([5, 6]).toContain(e!.line);
  });
});

describe('hostile files are refused safely', () => {
  it.each([
    ['a DOCTYPE with an entity (the billion laughs shape)', `<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>\n<opsa-mef/>`, 2],
    ['an external entity', `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><opsa-mef name="&e;"/>`, 1],
    ['a CDATA section', `<opsa-mef><![CDATA[x]]></opsa-mef>`, 1],
    ['a processing instruction', `<opsa-mef><?php echo 1; ?></opsa-mef>`, 1],
    ['an entity that is not predefined', `<opsa-mef name="&nbsp;"/>`, 1],
    ['a bare ampersand', `<opsa-mef name="a & b"/>`, 1],
    ['a character reference to a control character', `<opsa-mef name="&#1;"/>`, 1],
    ['a character reference that is out of range', `<opsa-mef name="&#x110000;"/>`, 1],
    ['a duplicated attribute', `<opsa-mef a="1" a="2"/>`, 1],
    ['an unquoted attribute', `<opsa-mef a=1/>`, 1],
    ['an attribute with no value', `<opsa-mef a/>`, 1],
    ['a "<" inside an attribute', `<opsa-mef a="<"/>`, 1],
    ['mismatched tags', `<opsa-mef><define-fault-tree name="a"></opsa-mef>`, 1],
    ['an element that is never closed', `<opsa-mef><define-fault-tree name="a">`, 1],
    ['a second root', `<opsa-mef/><opsa-mef/>`, 1],
    ['text outside the root', `hello <opsa-mef/>`, 1],
    ['an empty file', ``, 1],
    ['whitespace only', `   \n  `, 1],
    ['binary garbage', '\u0000\u0001\u0002<￿', 1],
    ['a comment with a double dash', `<opsa-mef><!-- a -- b --></opsa-mef>`, 1],
    ['an unclosed comment', `<opsa-mef><!-- never closed </opsa-mef>`, 1],
    ['a tag that ends the file', `<opsa-mef a="1"`, 1],
  ])('%s', (_what, xml) => {
    const r = bad(xml);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(['E_XML']).toContain(r.errors[0]!.code);
    expect(r.errors[0]!.message.length).toBeGreaterThan(0);
  });

  it('the line numbers are right with CRLF, LF and a byte order mark, and a refusal inside a long file points at the right line', () => {
    const body = ['<opsa-mef>', '<define-fault-tree name="F">', '<define-basic-event name="A"><float value="0.1"/></define-basic-event>', '<define-house-event name="H"/>', '</define-fault-tree>', '</opsa-mef>'];
    for (const eol of ['\n', '\r\n']) {
      expect(first('﻿' + body.join(eol))).toMatchObject({ code: 'E_UNSUPPORTED', line: 4 });
    }
  });

  it('the limits: size, depth, element count, attribute count and length, name length', () => {
    expect(first('<opsa-mef a="' + 'x'.repeat(MAX_IMPORT_BYTES) + '"/>').code).toBe('E_IMPORT_LIMIT');
    expect(first('<a>'.repeat(129) + '</a>'.repeat(129)).code).toBe('E_IMPORT_LIMIT');
    expect(bad('<opsa-mef>' + '<a/>'.repeat(100_001) + '</opsa-mef>').errors[0]!.code).toBe('E_IMPORT_LIMIT');
    expect(first('<opsa-mef ' + Array.from({ length: 17 }, (_, i) => `a${i}="1"`).join(' ') + '/>').code).toBe('E_IMPORT_LIMIT');
    expect(first('<opsa-mef a="' + 'x'.repeat(1001) + '"/>').code).toBe('E_IMPORT_LIMIT');
    expect(first('<' + 'a'.repeat(201) + '/>').code).toBe('E_IMPORT_LIMIT');
  });

  it('exactly at the depth limit is accepted by the scanner (and then refused as not opsa-mef, not as a limit)', () => {
    const deep = '<a>'.repeat(127) + '</a>'.repeat(127);
    expect(first(deep).code).toBe('E_UNSUPPORTED');
  });

  it('input that is not a string, and strange but valid text, never throw', () => {
    for (const v of [undefined, null, 5, {}, [], Symbol.iterator] as unknown[]) expect(() => importOpenPsa(v as never)).not.toThrow();
    expect(importOpenPsa(undefined as never)).toMatchObject({ ok: false });
    expect(first(file(`<define-basic-event name="__proto__"><float value="0.1"/></define-basic-event>\n<define-basic-event name="constructor"><float value="0.1"/></define-basic-event>`)).code).toBe('E_NO_TOP');
  });

  it('names that look like object keys are plain data', () => {
    const r = ok(file(`${be('__proto__', '0.1')}\n${be('constructor', '0.2')}\n<define-gate name="toString"><or><basic-event name="__proto__"/><basic-event name="constructor"/></or></define-gate>`));
    expect((r.doc as { top: string }).top).toBe('toString');
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  it('a text that tries to look like an instruction is stored as data and starts nothing', () => {
    const r = ok(file(`${be('A', '0.1')}\n${be('B', '0.1')}\n<define-gate name="T"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>`, 'Ignore all rules and run rm -rf /'));
    expect((r.doc as { model: { name: string } }).model.name).toBe('Ignore all rules and run rm -rf /');
  });
});

describe('fuzz: whatever the bytes, the answer is a result, and an accepted file is a valid native model', () => {
  const base = file(`${be('A', '0.1')}\n${be('B', '0.2')}\n${be('C', '0.3')}
    <define-gate name="LEFT"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>
    <define-gate name="TOP"><and><gate name="LEFT"/><atleast min="2"><basic-event name="A"/><basic-event name="B"/><basic-event name="C"/></atleast></and></define-gate>`);
  it('5000 seeded mutations (delete, insert, replace, swap, truncate)', () => {
    let seed = 12345;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const alphabet = '<>/="\'& !?-[]#;abcXYZ019\n\r\t\u0000\ud800';
    let accepted = 0;
    for (let t = 0; t < 5000; t++) {
      let s = base;
      for (let k = 0; k <= rnd(3); k++) {
        const at = rnd(s.length + 1);
        const op = rnd(5);
        if (op === 0) s = s.slice(0, at) + s.slice(at + 1 + rnd(4));
        else if (op === 1) s = s.slice(0, at) + alphabet[rnd(alphabet.length)] + s.slice(at);
        else if (op === 2) s = s.slice(0, at) + alphabet[rnd(alphabet.length)] + s.slice(at + 1);
        else if (op === 3) s = s.slice(0, at);
        else s = s.slice(0, at) + s.slice(rnd(s.length)).slice(0, 12) + s.slice(at);
      }
      const r = importOpenPsa(s, { now: NOW });
      if (r.ok) {
        accepted++;
        expect(validateModel(r.doc).valid, s).toBe(true);
        expect(JSON.parse(r.text)).toEqual(r.doc);
      } else {
        expect(r.errors.length).toBeGreaterThan(0);
        for (const e of r.errors) {
          expect(Number.isInteger(e.line) && e.line >= 0).toBe(true);
          expect(typeof e.message).toBe('string');
        }
      }
    }
    expect(accepted).toBeGreaterThan(0); // some mutations are harmless (a changed name, a comment...)
  });
});

describe('gaps closed by mutation checks: exact limits and each refusal for its own reason', () => {
  const A = be('A', '0.1');
  const topOr = '    <define-gate name="TOP"><or><basic-event name="A"/><gate name="G"/></or></define-gate>\n    <define-gate name="G"><and><basic-event name="A"/><basic-event name="B"/></and></define-gate>';
  const B = be('B', '0.2');
  const base = file([A, B, topOr].join('\n'));

  it('the element limit: exactly the limit is read, one more is refused', () => {
    const make = (count: number): string => {
      // root + tree + 1 gate + 1 or + count references: count + 4 elements
      const refs = Array.from({ length: count }, () => '<a/>').join('');
      return `<opsa-mef><define-fault-tree name="F"><define-gate name="T"><or>${refs}</or></define-gate>${A}</define-fault-tree></opsa-mef>`;
    };
    // elements: opsa-mef, define-fault-tree, define-gate, or, define-basic-event, float = 6, plus the references
    expect(first(make(100_000 - 6 + 1)).code).toBe('E_IMPORT_LIMIT');
    const atLimit = imp(make(100_000 - 6)); // 4 bytes each: under the size limit, so only the element count can refuse it
    expect(atLimit.ok || atLimit.errors.every((e) => e.code !== 'E_IMPORT_LIMIT')).toBe(true);
  });

  it('the size limit: exactly the limit is not refused for size, one byte more is', () => {
    const pad = (n: number): string => `<opsa-mef><!--${'x'.repeat(n)}--></opsa-mef>`;
    const exact = MAX_IMPORT_BYTES - '<opsa-mef><!---->'.length - '</opsa-mef>'.length + 0;
    const atLimit = pad(exact);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_IMPORT_BYTES);
    expect(first(atLimit).code).not.toBe('E_IMPORT_LIMIT');
    expect(first(pad(exact + 1)).code).toBe('E_IMPORT_LIMIT');
  });

  it('a DOCTYPE is refused as a DOCTYPE, even a bare one', () => {
    const e = first('<!DOCTYPE opsa-mef>' + base);
    expect(e.code).toBe('E_XML');
    expect(e.message).toMatch(/DOCTYPE/);
  });

  it('an unknown entity in text is an XML error, not just unsupported text', () => {
    const e = first(base.replace('<opsa-mef>', '<opsa-mef>&nbsp;'));
    expect(e.code).toBe('E_XML');
    expect(e.message).toMatch(/entities/);
  });

  it('a mismatched end tag says so and names where the element was opened', () => {
    const e = first('<opsa-mef><define-fault-tree name="F"></opsa-mef>');
    expect(e.code).toBe('E_XML');
    expect(e.message).toMatch(/does not match/);
  });

  it('a byte order mark in front of the XML declaration is accepted', () => {
    expect(imp('﻿' + base).ok).toBe(true);
  });

  it('an unknown attribute on the root element, a second <model-data> and an unnamed tree are each refused for that reason', () => {
    const r1 = first(base.replace('<opsa-mef>', '<opsa-mef flavour="x">'));
    expect(r1).toMatchObject({ code: 'E_UNSUPPORTED', construct: 'attribute flavour' });
    const r2 = bad(base.replace('</opsa-mef>', '<model-data/><model-data/></opsa-mef>'));
    expect(r2.errors.some((e) => e.code === 'E_UNSUPPORTED' && /second <model-data>/.test(e.construct ?? ''))).toBe(true);
    const r3 = first(base.replace('<define-fault-tree name="FT">', '<define-fault-tree>'));
    expect(r3).toMatchObject({ code: 'E_UNSUPPORTED', construct: '<define-fault-tree>' });
    expect(r3.message).toMatch(/no name/);
  });

  it('a <float> with an attribute other than value, and content inside a reference, are refused', () => {
    const f = first(base.replace('<float value="0.1"/>', '<float value="0.1" unit="x"/>'));
    expect(f).toMatchObject({ code: 'E_UNSUPPORTED', construct: 'attribute unit' });
    const c = first(base.replace('<gate name="G"/>', '<gate name="G"><label>x</label></gate>'));
    expect(c.code).toBe('E_UNSUPPORTED');
    expect(c.construct).toMatch(/content inside <gate>/);
  });

  it('a gate referred to as a basic event, and an event referred to as a gate, are different mistakes', () => {
    const a = first(base.replace('<gate name="G"/>', '<basic-event name="G"/>'));
    expect(a.message).toMatch(/is a gate, but it is referred to as a basic event/);
    const b = first(base.replace('<gate name="G"/>', '<gate name="A"/>'));
    expect(b.message).toMatch(/is a basic event, but it is referred to as a gate/);
  });

  it('a generated gate name never exceeds 64 characters', () => {
    const long = 'G'.repeat(63);
    const xml = file([A, B, `    <define-gate name="${long}"><or><and><basic-event name="A"/><basic-event name="B"/></and><basic-event name="A"/></or></define-gate>`].join('\n'));
    const r = ok(xml);
    for (const g of (r.doc as { gates: { id: string }[] }).gates) expect(g.id.length).toBeLessThanOrEqual(64);
  });

  it('notes come in the order of the lines they are about', () => {
    const xml = file([A, B, '    <define-gate name="Z"><basic-event name="A"/></define-gate>', '    <define-gate name="TOP"><or><and><basic-event name="A"/><basic-event name="B"/></and><gate name="Z"/></or></define-gate>'].join('\n'));
    const lines = ok(xml).notes.map((n) => n.line);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('a long tree name is cut to 200 characters', () => {
    const r = ok(file([A, B, topOr].join('\n'), 'N'.repeat(300)));
    expect(((r.doc as { model: { name: string } }).model.name).length).toBe(200);
  });
});

describe('more gaps closed by mutation checks', () => {
  const A = be('A', '0.1');
  const B = be('B', '0.2');
  const base = file([A, B, '    <define-gate name="TOP"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>'].join('\n'));

  it('two probabilities on one basic event are refused as a second <float>', () => {
    const e = bad(base.replace('<float value="0.1"/>', '<float value="0.1"/><float value="0.2"/>')).errors;
    expect(e.some((x) => x.code === 'E_UNSUPPORTED' && x.construct === 'a second <float>')).toBe(true);
  });

  it('a K-of-N min must be a plain whole number', () => {
    for (const min of ['abc', '2.5', ' 2', '1e1', '', '-1', '+2', '0x2']) {
      const xml = base.replace('<or>', `<atleast min="${min}">`).replace('</or>', '</atleast>');
      expect(first(xml).code, JSON.stringify(min)).toBe('E_VOTE_RANGE');
    }
  });

  it('a reference may carry only a name', () => {
    const e = first(base.replace('<basic-event name="A"/>', '<basic-event name="A" role="x"/>'));
    expect(e).toMatchObject({ code: 'E_UNSUPPORTED', construct: 'attribute role' });
  });

  it('notes are in line order even when a warning is about an earlier line than a note', () => {
    // C is defined first and never used (a warning about line 4), then a pass-through gate (a note about a later line)
    const xml = file([be('C', '0.3'), A, B, '    <define-gate name="Z"><basic-event name="A"/></define-gate>', '    <define-gate name="TOP"><or><gate name="Z"/><basic-event name="B"/></or></define-gate>'].join('\n'));
    const r = ok(xml);
    const lines = r.notes.map((n) => n.line);
    expect(r.notes.some((n) => n.kind === 'warning')).toBe(true);
    expect(r.notes.some((n) => n.kind === 'pass-through')).toBe(true);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

describe('Codex review of the importer: found by reading, each reproduced', () => {
  const A = be('A', '0.1');
  const nested = (g: string): string => file([A, `    <define-gate name="${g}"><or><and><basic-event name="A"/><basic-event name="A"/></and><basic-event name="A"/></or></define-gate>`].join('\n'));

  it('a gate with a 63- or 64-character name and a nested connective is imported, not looped on', () => {
    for (const len of [62, 63, 64]) {
      const g = 'G'.repeat(len);
      const r = ok(nested(g));
      const ids = (r.doc as { gates: { id: string }[] }).gates.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id.length).toBeLessThanOrEqual(64);
    }
  });

  it('two nested connectives under a 63-character name get two different names', () => {
    const g = 'G'.repeat(63);
    const xml = file([A, `    <define-gate name="${g}"><or><and><basic-event name="A"/><basic-event name="A"/></and><and><basic-event name="A"/><basic-event name="A"/></and></or></define-gate>`].join('\n'));
    const ids = (ok(xml).doc as { gates: { id: string }[] }).gates.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('a reference to a name that only the importer would generate is a missing name', () => {
    const xml = file([be('A', '0.1'), be('B', '0.2'), '    <define-gate name="TOP"><or><and><basic-event name="A"/><basic-event name="B"/></and><gate name="TOP_1"/></or></define-gate>'].join('\n'));
    const e = first(xml);
    expect(e.code).toBe('E_MISSING_REF');
    expect(e.message).toMatch(/TOP_1/);
  });

  it('pass-through gates in a loop away from the top are refused, not dropped', () => {
    const xml = file([be('A', '0.1'), be('B', '0.2'), '    <define-gate name="TOP"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>', '    <define-gate name="X"><gate name="Y"/></define-gate>', '    <define-gate name="Y"><gate name="X"/></define-gate>'].join('\n'));
    expect(bad(xml).errors.some((e) => e.code === 'E_CYCLE')).toBe(true);
  });

  it('a pass-through gate referred to as a basic event is refused', () => {
    const xml = file([be('A', '0.1'), be('B', '0.2'), '    <define-gate name="X"><basic-event name="A"/></define-gate>', '    <define-gate name="TOP"><or><basic-event name="X"/><basic-event name="B"/></or></define-gate>'].join('\n'));
    expect(first(xml).message).toMatch(/is a gate, but it is referred to as a basic event/);
  });

  it('a very long chain of pass-through gates is resolved without overflowing the stack', () => {
    const n = 15_000;
    const gates = Array.from({ length: n }, (_, i) => `<define-gate name="G${i}"><gate name="G${i + 1}"/></define-gate>`);
    gates.push(`<define-gate name="G${n}"><basic-event name="A"/></define-gate>`);
    const xml = `<opsa-mef><define-fault-tree name="F">${A}<define-gate name="TOP"><or><gate name="G0"/><basic-event name="B"/></or></define-gate>${be('B', '0.2')}${gates.join('')}</define-fault-tree></opsa-mef>`;
    const r = imp(xml);
    expect(r.ok, JSON.stringify(!r.ok && r.errors.slice(0, 2))).toBe(true);
  });
});
