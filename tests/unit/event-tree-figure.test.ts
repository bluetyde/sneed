import { describe, expect, it } from 'vitest';
import { enumeratePaths, pathKey } from '../../src/core/event-tree-paths.js';
import { EVENT_TREE_RESULT_SCHEMA, endStateLabel, type EventTreeResult } from '../../src/core/event-tree-result.js';
import * as E from '../../src/web/model/event-tree-doc.js';
import { MAX_DRAWN_SEQUENCES, eventTreeFileStem, eventTreeResultLines, eventTreeSvg } from '../../src/web/model/event-tree-figure.js';

const NOW = '2026-10-06T00:00:00Z';
const ref = { name: 'shared', hash: 'a'.repeat(64), top: 'TOP' };

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

function twoHeadings(): E.EtDoc {
  let d = E.newEventTree(ref, 'Shared case', NOW);
  d = E.patchHeading(d, 'H1', { name: 'Injection', event: 'X' }, NOW);
  d = E.addHeading(d, 'Y', NOW);
  d = E.patchHeading(d, 'H2', { name: 'Cooling' }, NOW);
  d = E.setInitiating(d, { frequency: 0.5 }, NOW);
  return E.setUnsetEnds(d, 'ES1', NOW);
}

function record(doc: E.EtDoc, over: Partial<EventTreeResult> = {}): EventTreeResult {
  const freqs = [0.252, 0.108, 0.063, 0.077];
  return {
    schema: EVENT_TREE_RESULT_SCHEMA,
    status: 'completed',
    completeness: 'complete',
    reasons: [],
    quantity: 'sequence_frequency',
    unit: 'per-year',
    method: 'exact-joint',
    assumptions: doc.assumptions,
    engine: { name: 'sneed-bdd', version: '0.1.0', sha256: null, runtime: null },
    input_hashes: { tree_hash: 't'.repeat(64), model_hash: 'm'.repeat(64), document_hash: 'd' },
    initiating_event: { name: doc.initiating_event.name, frequency: doc.initiating_event.frequency, unit: 'per-year' },
    headings: doc.headings.map((h) => ({ id: h.id, name: h.name, event: h.event })),
    sequences: doc.sequences.map((s, i) => ({ key: pathKey(s.path), path: s.path, end_state: s.end_state, probability: freqs[i]! * 2, frequency: freqs[i]!, share: freqs[i]! * 2 })),
    end_states: [{ id: 'ES1', name: 'End state 1 (example)', synthetic: true, frequency: 0.5, probability: 1, sequences: doc.sequences.map((s) => pathKey(s.path)) }],
    total: { frequency: 0.5, probability_sum: 1, partition_error: 0 },
    approximation: null,
    warnings: [],
    caveats: ['A frequency here is a model result under the stated assumptions, not a plant figure.'],
    ...over,
  };
}

describe('the figure of an event tree', () => {
  it('is a standalone, well-formed SVG with a title, one line per sequence and nothing from outside', () => {
    const d = twoHeadings();
    const svg = eventTreeSvg(d);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('<title id="t">Event tree: Shared case</title>');
    expect((svg.match(/<circle /g) ?? []).length).toBe(4); // one dot at the end of each sequence
    for (const w of ['Injection', 'Cooling', '1. End state 1 (example)', '4. End state 1 (example)']) expect(svg).toContain(w);
    expect(svg).not.toMatch(/<script|<style|var\(|href=|<image|<foreignObject|url\(/);
  });

  it('draws the same number of lines as the table lists sequences, bypass included, and passes over a heading that is not asked', () => {
    let d = twoHeadings();
    d = E.setBypass(d, 'H2', { heading: 'H1', branch: 'works' }, NOW);
    d = E.setUnsetEnds(d, 'ES1', NOW);
    expect(enumeratePaths(d.headings)).toHaveLength(3);
    const svg = eventTreeSvg(d);
    expect((svg.match(/<circle /g) ?? []).length).toBe(3);
    expect(svg).toContain('asked only if Injection works');
    // three headings, the last asked only after the first failed: five lines
    d = E.addHeading(d, 'TOP', NOW);
    d = E.setBypass(d, 'H3', { heading: 'H1', branch: 'fails' }, NOW);
    expect((eventTreeSvg(d).match(/<circle /g) ?? []).length).toBe(enumeratePaths(d.headings).length);
  });

  it('shows frequencies only from a current, complete result, and says so when there is none, an old one, or a failed one', () => {
    const d = twoHeadings();
    const none = eventTreeSvg(d);
    expect(none).not.toMatch(/per year<\/text>.*0\.252/s);
    expect(none).toContain('No result for this drawing');
    const cur = eventTreeSvg(d, { result: { record: record(d), stale: false } });
    for (const f of ['0.252 per year', '0.108 per year', '0.063 per year', '0.077 per year']) expect(cur).toContain(f);
    expect(cur).toContain('add up to 1');
    const old = eventTreeSvg(d, { result: { record: record(d), stale: true } });
    expect(old).toContain('NO CURRENT RESULT');
    expect(old).not.toContain('0.252');
    const failed = eventTreeSvg(d, { result: { record: record(d, { status: 'failed', completeness: 'unknown', reasons: ['timeout'], sequences: [], end_states: [], total: null }), stale: false } });
    expect(failed).toContain('DIAGNOSTIC ONLY');
    expect(failed).toContain('took too long');
    expect(failed).not.toContain('0.252');
  });

  it('names an approximation that was computed but does not draw it', () => {
    const d = twoHeadings();
    const lines = eventTreeResultLines({ record: record(d, { approximation: { method: 'success-branches-ignored', note: 'n', frequency_sum: 0.9 } }), stale: false });
    expect(lines.join('\n')).toMatch(/approximation was also computed.*not drawn/);
    expect(eventTreeSvg(d, { result: { record: record(d, { approximation: { method: 'success-branches-ignored', note: 'n', frequency_sum: 0.9 } }), stale: false } })).not.toContain('0.9');
  });

  it('too many sequences are not drawn, and the figure says where they are', () => {
    let d = E.newEventTree(ref, 'Big', NOW);
    for (let i = 0; i < 7; i++) d = E.addHeading(d, 'TOP', NOW); // 8 headings, 256 sequences
    expect(enumeratePaths(d.headings).length).toBeGreaterThan(MAX_DRAWN_SEQUENCES);
    const svg = eventTreeSvg(d);
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('too many sequences to draw');
    expect(svg).not.toContain('<circle');
    // exactly at the limit is still drawn
    let at = E.newEventTree(ref, 'At', NOW);
    for (let i = 0; i < 5; i++) at = E.addHeading(at, 'TOP', NOW); // 6 headings, 64 sequences
    expect(enumeratePaths(at.headings)).toHaveLength(MAX_DRAWN_SEQUENCES);
    expect((eventTreeSvg(at).match(/<circle /g) ?? []).length).toBe(MAX_DRAWN_SEQUENCES);
  });

  it('keeps hostile names inert and the document well-formed', () => {
    let d = twoHeadings();
    d = E.patchHeading(d, 'H1', { name: '<script>alert(1)</script> & "q"' }, NOW);
    d = E.patchEndState(d, 'ES1', { name: 'End \u0000 \u0007 state </text><text>' }, NOW);
    d = E.setTreeName(d, 'Tree \u001f]]> <b>', NOW);
    const svg = eventTreeSvg(d);
    expect(balanced(svg)).toBe(true);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<b>');
    // eslint-disable-next-line no-control-regex
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(svg).toContain('&lt;script&gt;');
  });

  it('is the same bytes for the same input (no clock, no randomness)', () => {
    const d = twoHeadings();
    const r = { record: record(d), stale: false };
    expect(eventTreeSvg(d, { result: r })).toBe(eventTreeSvg(d, { result: r }));
  });

  it('labels an example end state once, whatever its name says', () => {
    expect(endStateLabel('Safe', true)).toBe('Safe (example)');
    expect(endStateLabel('Safe (example)', true)).toBe('Safe (example)');
    expect(endStateLabel('Safe (Example) ', true)).toBe('Safe (Example) ');
    expect(endStateLabel('Safe', false)).toBe('Safe');
  });

  it('makes a safe file stem', () => {
    const d = twoHeadings();
    expect(eventTreeFileStem(d, 'my-tree')).toBe('my-tree');
    expect(eventTreeFileStem(d, null)).toBe('Shared-case');
    expect(eventTreeFileStem(E.setTreeName(d, '///', NOW), null)).toBe('event-tree');
    expect(eventTreeFileStem(d, '../../etc/passwd')).toBe('etc-passwd');
  });

  it('puts each frequency beside its own sequence, in the order of the table', () => {
    const d = twoHeadings();
    const svg = eventTreeSvg(d, { result: { record: record(d), stale: false } });
    const order = [...svg.matchAll(/>(\d)\. End state[^<]*<\/text><text[^>]*>([\d.]+) per year</g)].map((m) => [m[1], m[2]]);
    expect(order).toEqual([['1', '0.252'], ['2', '0.108'], ['3', '0.063'], ['4', '0.077']]);
  });

  it('a result that says completed but not complete is diagnostic only, never drawn as numbers', () => {
    const d = twoHeadings();
    const r = { record: record(d, { completeness: 'unknown' }), stale: false };
    expect(eventTreeResultLines(r)[0]).toMatch(/^DIAGNOSTIC ONLY/);
    expect(eventTreeSvg(d, { result: r })).not.toContain('0.252');
    const r2 = { record: record(d, { status: 'cancelled' }), stale: false };
    expect(eventTreeResultLines(r2)[0]).toMatch(/^DIAGNOSTIC ONLY/);
  });

  it('says an example end state is an example even when its name does not, and shows a missing one as missing', () => {
    let d = twoHeadings();
    d = E.patchEndState(d, 'ES1', { name: 'Safe', synthetic: true }, NOW);
    expect(eventTreeSvg(d)).toContain('1. Safe (example)');
    d = E.patchEndState(d, 'ES1', { synthetic: false }, NOW);
    expect(eventTreeSvg(d)).toContain('1. Safe<');
    d = E.setSequenceEnd(d, 'H1:fails,H2:fails', '', NOW);
    expect(eventTreeSvg(d)).toContain('4. (no end state)');
  });

  it('shows the check and the warnings of a current result', () => {
    const d = twoHeadings();
    const lines = eventTreeResultLines({ record: record(d, { total: { frequency: 0.5, probability_sum: 0.9999999999, partition_error: 1e-10 }, warnings: ['a zero frequency'] }), stale: false }).join(String.fromCharCode(10));
    expect(lines).toContain('add up to 1 (they must');
    expect(lines).toContain('difference 1.0e-10');
    expect(lines).toContain('Warning: a zero frequency');
    expect(lines).toContain('hash tttttttttttt');
  });
});
