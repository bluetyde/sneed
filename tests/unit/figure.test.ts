import { describe, expect, it } from 'vitest';
import * as D from '../../src/web/model/doc.js';
import { buildVisual } from '../../src/web/model/visual.js';
import { figureFileStem, figureSvg, resultLines, wrapText } from '../../src/web/model/figure.js';
import type { ResultRecord } from '../../src/core/result.js';
import { ORACLE_MODELS } from '../oracle/models.js';

const base = (): D.Doc => D.newModel('Pumps', '2026-10-05T00:00:00Z');
const record = (over: Partial<ResultRecord> = {}): ResultRecord =>
  ({
    schema_version: 1, status: 'completed', completeness: 'complete', reasons: [], quantity: 'top_event_probability', unit: 'dimensionless', method: 'exact', assumptions: {},
    engine: { name: 'sneed-bdd', version: '1', sha256: null, runtime: null }, warnings: [], settings: { method: 'exact', limitOrder: 2 },
    input_hashes: { model_hash: 'abcdef0123456789'.repeat(4), document_hash: 'd', exported_input_hash: 'e' }, exporter_version: 'x', parser_version: 'x',
    top_event_probability: 0.19, approximation_value: null, caveats: [], minimal_cut_sets: [{ events: ['E1'], probability: 0.1 }, { events: ['E2'], probability: 0.1 }], ...over,
  }) as ResultRecord;

/** Every start tag is closed or self-closed, in order: a cheap well-formedness check (the browser parses it for real in e2e). */
function balanced(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    if (m[4] === '/') continue;
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

describe('the figure of a drawing', () => {
  it('is a standalone, well-formed SVG with a title, every node, every edge and nothing from outside', () => {
    const d = base();
    const svg = figureSvg(d);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('<title id="t">Fault tree: Pumps</title>');
    for (const id of ['G1', 'E1', 'E2']) expect(svg).toContain(`>${id}`);
    expect((svg.match(/<path /g) ?? []).length).toBe(buildVisual(d).edges.length);
    expect(svg).not.toMatch(/<script|<style|var\(|href=|<image|<foreignObject|url\(/);
  });

  it('is the same bytes for the same input, and fits every node inside the page', () => {
    const d = D.setProbability(base(), 'E1', 0.25);
    expect(figureSvg(d)).toBe(figureSvg(d));
    const svg = figureSvg(d);
    const [, w, h] = /width="(\d+)" height="(\d+)" viewBox/.exec(svg)!.map(Number) as [number, number, number];
    expect(svg).toContain(`viewBox="0 0 ${w} ${h}"`);
    const v = buildVisual(d);
    expect(w).toBeGreaterThanOrEqual(v.bounds.w);
    expect(h).toBeGreaterThan(v.bounds.h);
  });

  it('draws the shapes that mean something without colour: ellipses for events, rectangles for gates, dashed for a repeated use', () => {
    const doc = ORACLE_MODELS['pra-shared'] as unknown as D.Doc;
    const svg = figureSvg(doc);
    expect((svg.match(/<ellipse /g) ?? []).length).toBe(buildVisual(doc).nodes.filter((n) => n.kind === 'event').length);
    expect(svg).toContain('stroke-dasharray="5 3"'); // repeated references
    expect(svg).toContain('↪ A'); // A is used under both AB and AC
    expect(svg).not.toMatch(/#(?!000|fff)[0-9a-f]{3,6}/i); // black and white only
    expect(svg).toContain('>TOP<'); // the top event badge
  });

  it('writes names and a hostile model name as text, never as markup', () => {
    let d = base();
    d = D.setName(d, 'E1', '<b>"x"&y</b>');
    d = D.setModelName(d, '</title><script>alert(1)</script>');
    const svg = figureSvg(d);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;/title&gt;&lt;script&gt;');
    expect(balanced(svg)).toBe(true);
  });

  it('says what it is: assumptions, legend, application name, and a date only when given', () => {
    const svg = figureSvg(base());
    expect(svg).toContain('Ellipse: basic event');
    expect(svg).toContain('not a frequency and not a plant risk figure');
    expect(svg).toContain('SNEED fault-tree editor');
    expect(svg).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(figureSvg(base(), { generated: '2026-10-06' })).toContain('2026-10-06');
  });

  it('an empty drawing is still a valid figure', () => {
    const d = D.emptyModel('Nothing', '2026-10-05T00:00:00Z');
    const svg = figureSvg(d);
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('The drawing is empty.');
  });
});

describe('the result in the figure', () => {
  it('a complete current result gives the probability, method, engine, status and cut set count', () => {
    const lines = resultLines({ record: record(), stale: false }).join('\n');
    expect(lines).toContain('Top event probability: 0.19.');
    expect(lines).toContain('Method: Exact. Engine: sneed-bdd 1. Status: completed / complete.');
    expect(lines).toContain('Minimal cut sets: 2.');
    expect(lines).toContain('Model hash abcdef012345.');
    expect(lines).not.toContain('DIAGNOSTIC');
    expect(figureSvg(base(), { result: { record: record(), stale: false } })).toContain('Top event probability: 0.19.');
  });

  it('a result that is not complete is labelled diagnostic only, with its reasons, never as an analysis', () => {
    const lines = resultLines({ record: record({ status: 'truncated', completeness: 'truncated', reasons: ['timeout'], top_event_probability: 0.12 }), stale: false });
    expect(lines[0]).toMatch(/^DIAGNOSTIC ONLY: the run is truncated \/ truncated/);
    expect(lines.length).toBeGreaterThan(2);
    expect(figureSvg(base(), { result: { record: record({ status: 'truncated', completeness: 'truncated' }), stale: false } })).toContain('font-weight="bold" xml:space="preserve">DIAGNOSTIC ONLY');
  });

  it('a stale result shows no numbers at all, only that there is no current result', () => {
    const lines = resultLines({ record: record(), stale: true }).join('\n');
    expect(lines).toContain('NO CURRENT RESULT');
    expect(lines).not.toContain('0.19');
    expect(lines).not.toContain('Minimal cut sets');
  });

  it('no result at all says the model has not been run; an approximation says so and carries its caveats', () => {
    expect(resultLines(null)).toEqual(['No result for this drawing: the model has not been run.']);
    const approx = resultLines({ record: record({ method: 'rare-event', top_event_probability: 1, caveats: ['approximation-exceeds-1'] }), stale: false }).join('\n');
    expect(approx).toContain('Top event probability: 1 (approximation).');
    expect(approx).toContain('rare-event sum is above 1');
  });

  it('probabilities are written without float noise and tiny ones in exponent form', () => {
    expect(resultLines({ record: record({ top_event_probability: 0.1 + 0.2 }), stale: false }).join('\n')).toContain('Top event probability: 0.3.');
    expect(resultLines({ record: record({ top_event_probability: 1.5e-9 }), stale: false }).join('\n')).toContain('1.50000e-9');
    expect(resultLines({ record: record({ top_event_probability: 0 }), stale: false }).join('\n')).toContain('Top event probability: 0.');
  });
});

describe('text wrapping and file names', () => {
  it('wraps at spaces, keeps the indent of a continuation and never drops a word', () => {
    const out = wrapText('  one two three four five six', 14);
    expect(out.every((l) => l.length <= 14 && l.startsWith('  '))).toBe(true);
    expect(out.join(' ').replace(/ +/g, ' ').trim()).toBe('one two three four five six');
    expect(wrapText('short', 80)).toEqual(['short']);
    expect(wrapText('unbreakableunbreakable', 5)).toEqual(['unbreakableunbreakable']);
  });

  it('makes a plain file stem from the file or the model name', () => {
    expect(figureFileStem(base(), 'my-model')).toBe('my-model');
    expect(figureFileStem(base(), null)).toBe('Pumps');
    expect(figureFileStem(D.setModelName(base(), '../../évil name?.'), null)).toBe('vil-name');
    expect(figureFileStem(D.setModelName(base(), '???'), null)).toBe('fault-tree');
    expect(figureFileStem(D.setModelName(base(), 'x'.repeat(100)), null).length).toBe(64);
  });
});

describe('gaps closed by mutation checks', () => {
  it('every special character of a name is escaped, in order', () => {
    const svg = figureSvg(D.setName(base(), 'E1', '<b>"x"&y</b>'));
    expect(svg).toContain('E1 &lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;');
    expect(svg).not.toContain('&amp;amp;');
  });

  it('the reasons of an incomplete run are listed, and the status and the completeness each decide', () => {
    expect(resultLines({ record: record({ status: 'truncated', completeness: 'truncated', reasons: ['timeout'] }), stale: false })[1]).toContain('took too long');
    expect(resultLines({ record: record({ status: 'failed', completeness: 'complete' }), stale: false })[0]).toContain('DIAGNOSTIC ONLY');
    expect(resultLines({ record: record({ status: 'completed', completeness: 'truncated' }), stale: false })[0]).toContain('DIAGNOSTIC ONLY');
    expect(resultLines({ record: record(), stale: false })[0]).not.toContain('DIAGNOSTIC');
  });

  it('exactly the repeated uses are dashed: their boxes and their edges, not the gates', () => {
    const doc = ORACLE_MODELS['pra-shared'] as unknown as D.Doc;
    const v = buildVisual(doc);
    const refs = v.nodes.filter((n) => n.kind === 'reference' || n.kind === 'missing').length;
    expect(refs).toBeGreaterThan(0);
    expect((figureSvg(doc).match(/stroke-dasharray="5 3"/g) ?? []).length).toBe(2 * refs);
    expect(figureSvg(base())).not.toContain('stroke-dasharray');
  });

  it('long caption lines are wrapped to the width of the figure', () => {
    const svg = figureSvg(base(), { result: { record: record({ method: 'rare-event', top_event_probability: 1, caveats: ['approximation-exceeds-1'] }), stale: false } });
    const width = Number(/width="(\d+)" height/.exec(svg)![1]);
    const lines = [...svg.matchAll(/xml:space="preserve">([^<]*)</g)].map((m) => m[1]!);
    expect(lines.length).toBeGreaterThan(6);
    for (const l of lines) expect(l.length * 6.6).toBeLessThanOrEqual(width - 48 + 6.6);
  });

  it('a wide drawing makes a wide figure, and the tree starts just below the caption', () => {
    let d = base();
    for (let i = 0; i < 9; i++) d = D.addEvent(d, { parent: 'G1' }).doc;
    const v = buildVisual(d);
    expect(v.bounds.w).toBeGreaterThan(700);
    const svg = figureSvg(d);
    expect(Number(/width="(\d+)" height/.exec(svg)![1])).toBeGreaterThanOrEqual(v.bounds.w + 48);
    const ty = Number(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">/.exec(svg)![2]);
    expect(v.bounds.y + ty).toBeCloseTo(24 + 20 + 2 * 16 + 10, 5); // margin + caption block
  });
});

describe('the second engine in the figure, and characters XML cannot hold', () => {
  const eng = { name: 'SCRAM', version: '0.16.2' };
  it('an agreement, a disagreement and an unavailable comparison are each in the figure next to the numbers', () => {
    const agree = resultLines({ record: record(), stale: false, cross: { engine: eng, status: 'completed', agree: true, differences: [] } }).join('\n');
    expect(agree).toContain('Cross-check: SCRAM 0.16.2 gives the same probability and the same minimal cut sets.');
    const differ = resultLines({ record: record(), stale: false, cross: { engine: eng, status: 'completed', agree: false, differences: ['the probabilities differ: 0.19 and 0.2'] } }).join('\n');
    expect(differ).toContain('CROSS-CHECK DISAGREEMENT');
    expect(differ).toContain('the probabilities differ: 0.19 and 0.2');
    const none = resultLines({ record: record(), stale: false, cross: { unavailable: true, reason: 'the SCRAM runtime is not installed' } }).join('\n');
    expect(none).toContain('Cross-check: no second opinion (the SCRAM runtime is not installed).');
    expect(resultLines({ record: record(), stale: false }).join('\n')).not.toContain('Cross-check');
    expect(figureSvg(base(), { result: { record: record(), stale: false, cross: { engine: eng, status: 'completed', agree: false, differences: ['x'] } } })).toContain('CROSS-CHECK DISAGREEMENT');
  });

  it('a stale result carries no cross-check either', () => {
    expect(resultLines({ record: record(), stale: true, cross: { engine: eng, status: 'completed', agree: false, differences: ['x'] } }).join('\n')).not.toContain('Cross-check');
  });

  it('control characters and lone surrogates in a name are replaced, so the document stays valid XML', () => {
    const svg = figureSvg(D.setModelName(base(), 'Pumps\u000cRe\u0000port\ud800x\ufffe'));
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/);
    expect(svg).toContain('Pumps\ufffdRe\ufffdport\ufffdx\ufffd');
    expect(figureSvg(D.setModelName(base(), 'tab\there'))).toContain('tab\there'); // allowed controls stay
    expect(figureSvg(D.setModelName(base(), 'pump \u{1F4A7}'))).toContain('\u{1F4A7}'); // astral characters stay
  });
});

