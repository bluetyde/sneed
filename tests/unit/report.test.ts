import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReportError, parseReport } from '../../src/core/report.js';
import { makeReport } from '../oracle/reportgen.js';

const spike = join(import.meta.dirname, '../../docs/spike/runs');
const real = (id: string): string => readFileSync(join(spike, id, 'report.xml'), 'utf8');
const code = (text: string): string => {
  try {
    parseReport(text);
  } catch (e) {
    if (e instanceof ReportError) return e.code;
    throw e;
  }
  return 'parsed';
};

describe('real SCRAM 0.16.2 reports saved in docs/spike/runs', () => {
  it('pra-and', () => {
    const r = parseReport(real('pra-and'));
    expect(r.software).toEqual({ name: 'SCRAM', version: '0.16.2' });
    expect(r.probability).toBe(0.02);
    expect(r.products).toEqual([{ order: 2, probability: 0.02, events: ['A', 'B'] }]);
    expect(r.approximation).toBe('none');
    expect(r.productOrderLimit).toBe(20);
    expect(r.warning).toBeNull();
    expect(r.cutSetMethod).toBe('Binary Decision Diagram');
  });

  it('a basic-event top reports the event, not the wrapper gate', () => {
    const r = parseReport(real('pra-pump1'));
    expect(r.products).toEqual([{ order: 1, probability: 0.1, events: ['P'] }]);
  });

  it('rare-event and MCUB methods are reported as such', () => {
    expect(parseReport(real('pra-vote-mcub')).approximation).toBe('mcub');
    expect(parseReport(real('pra-vote-mcub')).probability).toBe(0.029701);
  });

  it('the engine warning on an emptied result is preserved', () => {
    const r = parseReport(real('trunc-limit-order-2'));
    expect(r.products).toEqual([]);
    expect(r.warning).toBe('The set is NULL/Empty.');
    expect(r.probability).toBe(0.006);
    expect(r.productOrderLimit).toBe(2);
  });

  it('every saved report that exists parses to an object with a finite probability', () => {
    let n = 0;
    for (const id of ['pra-and', 'pra-or', 'pra-shared', 'pra-pump3-separate', 'native-atleast-2of3', 'trunc-limit-2-zbdd', 'trunc-default-limit-21-events']) {
      const r = parseReport(real(id));
      expect(Number.isFinite(r.probability), id).toBe(true);
      n++;
    }
    expect(n).toBe(7);
  });
});

describe('the parser refuses what it cannot trust', () => {
  const good = makeReport({ products: [{ events: ['A', 'B'], probability: '0.02' }], probability: '0.02' });

  it('accepts the generated layout (the fabricated reports are faithful)', () => {
    expect(code(good)).toBe('parsed');
    expect(parseReport(good).products[0]!.events).toEqual(['A', 'B']);
  });

  it('empty, whitespace and non-XML input', () => {
    expect(code('')).toBe('R_MISSING');
    expect(code('   \n')).toBe('R_MISSING');
    expect(code('not xml at all')).toBe('R_MALFORMED');
    expect(code('<report><information>')).toBe('R_MALFORMED');
  });

  it('a DTD, an entity declaration or a CDATA section', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]>' + good.replace('<?xml version="1.0" encoding="UTF-8"?>', '');
    expect(code(bomb)).toBe('R_UNSAFE');
    expect(code(good.replace('<report>', '<!DOCTYPE report><report>'))).toBe('R_UNSAFE');
    expect(code(good.replace('<time>2026', '<time><![CDATA[2026'))).toBe('R_UNSAFE');
  });

  it('missing structure', () => {
    expect(code(good.replace('<report>', '<other>').replace('</report>', '</other>'))).toBe('R_MALFORMED');
    expect(code(good.replace(/<software[^>]*\/>/, ''))).toBe('R_MISSING');
    expect(code(good.replace(/<sum-of-products[\s\S]*<\/sum-of-products>/, ''))).toBe('R_MISSING');
    expect(code(makeReport({ extraSums: 1 }))).toBe('R_MISSING');
  });

  it('values that are not numbers', () => {
    for (const bad of ['abc', '', 'NaN', 'Infinity', '1e999', '0.1.2', '--1']) {
      expect(code(makeReport({ probability: bad })), JSON.stringify(bad)).toBe('R_VALUE');
    }
    expect(code(makeReport({ products: [{ events: ['A'], probability: 'x' }] }))).toBe('R_VALUE');
    expect(code(makeReport({ products: [{ events: ['A'], probability: '0.1', order: Number.NaN }] }))).toBe('R_VALUE');
  });

  it('a software element without a version is refused, not read as an unknown version', () => {
    expect(code(good.replace(' version="0.16.2"', ''))).toBe('R_MISSING');
    expect(code(good.replace(' name="SCRAM"', ''))).toBe('R_MISSING');
  });

  it('an unnamed event in a cut set', () => {
    expect(code(good.replace('<basic-event name="A"/>', '<basic-event/>'))).toBe('R_MALFORMED');
  });

  it('missing optional facts come back as null, not guesses', () => {
    const r = parseReport(makeReport({ approximation: null, limit: null, products: [{ events: ['A'], probability: '0.1' }] }));
    expect(r.approximation).toBeNull();
    expect(r.productOrderLimit).toBeNull();
  });

  it('text inside the report is never interpreted', () => {
    const r = parseReport(good.replace('contacts="https://scram-pra.org"', 'contacts="$(rm -rf /)"'));
    expect(r.software.name).toBe('SCRAM');
  });

  it('a very large report is parsed or refused without throwing anything but ReportError', () => {
    const many = makeReport({ products: Array.from({ length: 3000 }, (_, i) => ({ events: [`E${i}`], probability: '0.1' })) });
    expect(parseReport(many).products).toHaveLength(3000);
  });
});
