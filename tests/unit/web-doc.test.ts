import { describe, expect, it } from 'vitest';
import * as D from '../../src/web/model/doc.js';
import { buildVisual, keysFor, neighbor, readingOrder, NODE_W } from '../../src/web/model/visual.js';
import { validateModel } from '../../src/core/validate.js';

const base = (): D.Doc => D.newModel('Test', '2026-10-05T00:00:00Z');
const valid = (d: D.Doc): boolean => validateModel(d).valid;
const codes = (d: D.Doc): string[] => validateModel(d).errors.map((e) => e.code);

describe('a new model', () => {
  it('is valid at once: an OR of two basic events', () => {
    const d = base();
    expect(d.top).toBe('G1');
    expect(d.gates).toEqual([{ id: 'G1', type: 'or', inputs: ['E1', 'E2'] }]);
    expect(valid(d)).toBe(true);
  });
});

describe('editing operations never change their input and keep unknown fields', () => {
  it('returns new documents and leaves the original untouched', () => {
    const d = base();
    const before = JSON.stringify(d);
    D.addEvent(d);
    D.addGate(d, 'and');
    D.connect(d, 'G1', 'E1');
    D.removeNode(d, 'E1');
    D.setProbability(d, 'E1', 0.5);
    D.moveNode(d, 'G1', 1, 2);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('carries unknown fields on the document, events and gates through every edit', () => {
    const d = { ...base(), 'x-note': { keep: true } } as D.Doc;
    d.events[0]!['x-owner'] = 'student';
    d.gates[0]!['x-flag'] = 1;
    let e = D.setProbability(d, 'E1', 0.3);
    e = D.setName(e, 'G1', 'Top gate');
    e = D.addEvent(e).doc;
    e = D.moveNode(e, 'G1', 5, 5);
    expect(e['x-note']).toEqual({ keep: true });
    expect(e.events[0]!['x-owner']).toBe('student');
    expect(e.gates[0]!['x-flag']).toBe(1);
  });
});

describe('ids', () => {
  it('uses the smallest unused id and fills gaps', () => {
    let d = base();
    expect(D.nextId(d, 'E')).toBe('E3');
    expect(D.nextId(d, 'G')).toBe('G2');
    d = D.removeNode(d, 'E1');
    expect(D.nextId(d, 'E')).toBe('E1');
  });

  it('every generated id satisfies the identifier pattern', () => {
    let d = base();
    for (let i = 0; i < 30; i++) d = i % 2 ? D.addEvent(d).doc : D.addGate(d, 'and').doc;
    for (const id of [...d.events.map((e) => e.id), ...d.gates.map((g) => g.id)]) expect(id).toMatch(/^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/);
    expect(new Set([...d.events.map((e) => e.id), ...d.gates.map((g) => g.id)]).size).toBe(d.events.length + d.gates.length);
  });
});

describe('adding nodes', () => {
  it('a gate arrives valid: two new events (three for K-of-N) as inputs', () => {
    const { doc, id } = D.addGate(base(), 'and', { parent: 'G1' });
    expect(D.findGate(doc, id)).toMatchObject({ type: 'and', inputs: ['E3', 'E4'] });
    expect(D.findGate(doc, 'G1')!.inputs).toEqual(['E1', 'E2', id]);
    expect(valid(doc)).toBe(true);
    const vote = D.addGate(base(), 'atleast', { parent: 'G1' });
    expect(D.findGate(vote.doc, vote.id)).toMatchObject({ type: 'atleast', threshold: 2, inputs: ['E3', 'E4', 'E5'] });
    expect(valid(vote.doc)).toBe(true);
  });

  it('an event attached to a gate becomes its last input; an unattached one is only a warning', () => {
    const attached = D.addEvent(base(), { parent: 'G1' });
    expect(D.findGate(attached.doc, 'G1')!.inputs).toEqual(['E1', 'E2', 'E3']);
    const loose = D.addEvent(base());
    expect(valid(loose.doc)).toBe(true);
    expect(validateModel(loose.doc).warnings.map((w) => w.code)).toEqual(['W_UNREACHABLE']);
  });

  it('the first node of an empty model becomes the top', () => {
    const empty = D.removeNode(D.removeNode(D.removeNode(base(), 'G1'), 'E1'), 'E2');
    expect(empty.top).toBe('');
    expect(D.addEvent(empty).doc.top).toBe('E1');
    expect(D.addGate(empty, 'or').doc.top).toBe('G1');
  });
});

describe('connecting', () => {
  it('a repeated id is one event referenced twice, and A AND A is legal', () => {
    let d = D.addGate(base(), 'and', { parent: 'G1' }).doc; // G2 over E3, E4
    d = D.connect(d, 'G2', 'E1');
    expect(D.findGate(d, 'G2')!.inputs).toEqual(['E3', 'E4', 'E1']);
    expect(valid(d)).toBe(true);
    const same = D.connect(D.disconnect(D.disconnect(D.connect(base(), 'G1', 'E1'), 'G1', 1), 'G1', 1), 'G1', 'E1');
    expect(D.findGate(same, 'G1')!.inputs).toEqual(['E1', 'E1']);
    expect(valid(same)).toBe(true);
  });

  it('disconnect removes exactly one slot, so a repeated reference removes only that occurrence', () => {
    const d = D.connect(base(), 'G1', 'E1'); // [E1, E2, E1]
    expect(D.findGate(D.disconnect(d, 'G1', 2), 'G1')!.inputs).toEqual(['E1', 'E2']);
    expect(D.findGate(D.disconnect(d, 'G1', 0), 'G1')!.inputs).toEqual(['E2', 'E1']);
    expect(D.findGate(D.disconnect(d, 'G1', 9), 'G1')!.inputs).toEqual(['E1', 'E2', 'E1']); // out of range: unchanged
  });

  it('the editor allows what the validator will name: a cycle, a one-input AND, a missing reference', () => {
    const cyc = D.connect(D.addGate(base(), 'and', { parent: 'G1' }).doc, 'G2', 'G1');
    expect(codes(cyc)).toEqual(['E_CYCLE']);
    const one = D.disconnect(D.addGate(base(), 'and', { parent: 'G1' }).doc, 'G2', 1);
    expect(codes(one)).toEqual(['E_GATE_ARITY']);
    expect(codes(D.connect(base(), 'G1', 'NOPE'))).toEqual(['E_MISSING_REF']);
  });
});

describe('deleting', () => {
  it('removes the node from every gate and from the layout, and the top when it was the top', () => {
    let d = D.moveNode(D.connect(base(), 'G1', 'E1'), 'E1', 4, 4);
    d = D.removeNode(d, 'E1');
    expect(D.findGate(d, 'G1')!.inputs).toEqual(['E2']);
    expect(d.layout?.nodes ?? []).toEqual([]);
    expect(D.removeNode(base(), 'G1').top).toBe('');
    expect(codes(D.removeNode(base(), 'G1'))).toEqual(['E_NO_TOP']);
  });

  it('deleting a gate leaves its inputs as unattached nodes, not deleted events', () => {
    const d = D.removeNode(D.addGate(base(), 'and', { parent: 'G1' }).doc, 'G2');
    expect(d.events.map((e) => e.id)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(validateModel(d).warnings.map((w) => w.code)).toEqual(['W_UNREACHABLE', 'W_UNREACHABLE']);
  });
});

describe('properties', () => {
  it('changing a gate type fixes the threshold: K-of-N gets 2, AND and OR lose it', () => {
    // a two-input gate cannot become K-of-N (2 <= k < 2 has no k): the validator names it instead of the editor refusing
    expect(codes(D.setGateType(D.addGate(base(), 'and', { parent: 'G1' }).doc, 'G2', 'atleast'))).toEqual(['E_VOTE_RANGE']);
    let d = D.setGateType(D.connect(D.addGate(base(), 'and', { parent: 'G1' }).doc, 'G2', 'E1'), 'G2', 'atleast'); // three inputs now
    expect(D.findGate(d, 'G2')!.threshold).toBe(2);
    expect(valid(d)).toBe(true);
    d = D.setThreshold(d, 'G2', 1);
    expect(codes(d)).toEqual(['E_VOTE_RANGE']);
    d = D.setGateType(d, 'G2', 'or');
    expect('threshold' in D.findGate(d, 'G2')!).toBe(false);
    expect(valid(d)).toBe(true);
  });

  it('names and notes can be set and cleared; ids never change', () => {
    let d = D.setName(D.setNote(base(), 'E1', 'pump'), 'E1', 'Pump 1');
    expect(D.findEvent(d, 'E1')).toMatchObject({ id: 'E1', name: 'Pump 1', note: 'pump' });
    d = D.setNote(D.setName(d, 'E1', ''), 'E1', '');
    expect(D.findEvent(d, 'E1')).toEqual({ id: 'E1', probability: 0.1 });
  });

  it('a sourced probability carries its citation; other kinds carry none', () => {
    let d = D.setSource(base(), 'E1', 'sourced', 'NUREG example');
    expect(D.findEvent(d, 'E1')!.source).toEqual({ kind: 'sourced', citation: 'NUREG example' });
    expect(valid(d)).toBe(true);
    d = D.setSource(d, 'E1', 'synthetic');
    expect(D.findEvent(d, 'E1')!.source).toEqual({ kind: 'synthetic' });
    expect(D.findEvent(D.setSource(d, 'E1', ''), 'E1')!.source).toBeUndefined();
    expect(codes(D.setSource(base(), 'E1', 'sourced'))).toEqual(['E_SCHEMA']); // empty citation is refused by the schema
  });

  it('out-of-range probabilities are stored as typed, so the validator names them', () => {
    expect(codes(D.setProbability(base(), 'E1', 1.5))).toEqual(['E_PROB_RANGE']);
    expect(codes(D.setProbability(base(), 'E1', -0.1))).toEqual(['E_PROB_RANGE']);
  });
});

describe('layout is separate from the model', () => {
  it('moving a node records a position and nothing else changes', () => {
    const d = D.moveNode(base(), 'E1', 40, 80);
    expect(d.layout).toEqual({ nodes: [{ id: 'E1', x: 40, y: 80 }] });
    const { layout: _a, ...rest } = d;
    const { layout: _b, ...orig } = base();
    expect(rest).toEqual(orig);
    expect(D.moveNode(d, 'E1', 1, 2).layout!.nodes).toEqual([{ id: 'E1', x: 1, y: 2 }]);
  });

  it('a repeated reference is positioned by its slot, and a stale key is ignored', () => {
    const d = D.connect(base(), 'G1', 'E1');
    const m = D.moveNode(d, 'G1#2', 9, 9);
    expect(m.layout!.references).toEqual([{ node: 'G1#2', target: 'E1', x: 9, y: 9 }]);
    expect(D.moveNode(base(), 'G1#7', 1, 1).layout?.references ?? []).toEqual([]);
  });

  it('resetLayout forgets every position', () => {
    expect(D.resetLayout(D.moveNode(base(), 'E1', 1, 1)).layout).toBeUndefined();
  });
});

describe('serialize and parse', () => {
  it('round-trips and ends with a newline', () => {
    const d = D.moveNode(base(), 'E1', 3, 3);
    const t = D.serialize(d);
    expect(t.endsWith('\n')).toBe(true);
    expect(D.parseDoc(t)).toEqual(d);
  });

  it('refuses a file the editor cannot draw instead of repairing it', () => {
    expect(() => D.parseDoc('[]')).toThrow(/JSON object/);
    expect(() => D.parseDoc(JSON.stringify({ ...base(), events: 'no' }))).toThrow(/cannot be drawn/);
    expect(() => D.parseDoc(JSON.stringify({ ...base(), gates: null }))).toThrow(/cannot be drawn/);
    expect(D.parseDoc(JSON.stringify({ ...base(), top: undefined })).top).toBe(''); // a missing top is left for the validator to name
  });
});

describe('the visual tree', () => {
  it('draws each node once and every further occurrence as a repeated-reference marker', () => {
    let d = D.addGate(base(), 'and', { parent: 'G1' }).doc; // G1 over E1, E2, G2; G2 over E3, E4
    d = D.connect(d, 'G2', 'E1'); // E1 is now used twice
    const v = buildVisual(d);
    const refs = v.nodes.filter((n) => n.kind === 'reference');
    expect(refs.map((r) => [r.key, r.id, r.targetKind])).toEqual([['G2#2', 'E1', 'event']]);
    expect(v.nodes.filter((n) => n.kind === 'event' && n.id === 'E1')).toHaveLength(1);
    expect(keysFor(v, 'E1').sort()).toEqual(['E1', 'G2#2']);
  });

  it('A AND A draws one event and one reference, never two events', () => {
    const d = D.connect(D.disconnect(D.disconnect(base(), 'G1', 1), 'G1', 0), 'G1', 'E1');
    const same = D.connect(d, 'G1', 'E1');
    const v = buildVisual(same);
    expect(v.nodes.filter((n) => n.kind === 'event' && n.id === 'E1')).toHaveLength(1);
    expect(v.nodes.filter((n) => n.kind === 'reference')).toHaveLength(1);
    expect(v.nodes.filter((n) => n.kind === 'reference')[0]).toMatchObject({ id: 'E1', parent: 'G1' });
  });

  it('a missing id is drawn as a missing marker, and a cycle ends in a reference instead of recursing forever', () => {
    expect(buildVisual(D.connect(base(), 'G1', 'NOPE')).nodes.filter((n) => n.kind === 'missing').map((n) => n.id)).toEqual(['NOPE']);
    const cyc = D.connect(D.addGate(base(), 'and', { parent: 'G1' }).doc, 'G2', 'G1');
    const v = buildVisual(cyc);
    expect(v.nodes.some((n) => n.kind === 'reference' && n.id === 'G1')).toBe(true);
    expect(v.nodes.length).toBeLessThan(20);
  });

  it('puts the top tree first and unattached trees after it', () => {
    let d = D.addEvent(base()).doc; // E3 unattached
    d = D.addGate(d, 'or').doc; // G2 over E4, E5 unattached
    const v = buildVisual(d);
    expect(v.roots).toEqual(['G1', 'G2', 'E3']);
    expect(v.byKey.get('G1')!.root).toBe(true);
    expect(v.byKey.get('E1')!.root).toBe(false);
  });

  it('lays a tree out tidily: parents centred over their inputs, no overlap on a level, depth sets the row', () => {
    let d = D.addGate(base(), 'and', { parent: 'G1' }).doc;
    d = D.addGate(d, 'or', { parent: 'G2' }).doc;
    const v = buildVisual(d);
    const byDepth = new Map<number, typeof v.nodes>();
    for (const n of v.nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
    for (const [depth, row] of byDepth) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.x - sorted[i - 1]!.x, `depth ${depth}`).toBeGreaterThanOrEqual((sorted[i]!.w + sorted[i - 1]!.w) / 2);
      for (const n of row) expect(n.y).toBe(depth * 112);
    }
    for (const g of v.nodes.filter((n) => n.kind === 'gate')) {
      const kids = v.edges.filter((e) => e.from === g.key).map((e) => v.byKey.get(e.to)!);
      expect(g.x).toBeCloseTo((Math.min(...kids.map((k) => k.x)) + Math.max(...kids.map((k) => k.x))) / 2, 6);
    }
    expect(NODE_W).toBeGreaterThan(100);
  });

  it('stored positions win over the automatic ones; a reference is moved by its own key', () => {
    let d = D.connect(base(), 'G1', 'E1');
    const auto = buildVisual(d);
    d = D.moveNode(D.moveNode(d, 'E2', 500, 600), 'G1#2', 70, 80);
    const v = buildVisual(d);
    expect(v.byKey.get('E2')).toMatchObject({ x: 500, y: 600, placed: true });
    expect(v.byKey.get('G1#2')).toMatchObject({ x: 70, y: 80, placed: true });
    expect(v.byKey.get('E1')!.x).toBe(auto.byKey.get('E1')!.x); // others keep their automatic place
    expect(v.byKey.get('E1')!.placed).toBe(false);
  });

  it('bounds cover every node', () => {
    const v = buildVisual(D.addGate(base(), 'and', { parent: 'G1' }).doc);
    for (const n of v.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(v.bounds.x - 1e-9);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(v.bounds.x + v.bounds.w + 1e-9);
    }
  });

  it('input order is slot order, left to right', () => {
    const v = buildVisual(base());
    expect(v.byKey.get('E1')!.x).toBeLessThan(v.byKey.get('E2')!.x);
  });
});

describe('keyboard navigation over the drawing', () => {
  const d = D.addGate(base(), 'and', { parent: 'G1' }).doc; // G1 -> E1, E2, G2 ; G2 -> E3, E4
  const v = buildVisual(d);

  it('moves up to the parent, down to the first input and sideways between siblings', () => {
    expect(neighbor(v, 'G1', 'down')).toBe('E1');
    expect(neighbor(v, 'E1', 'right')).toBe('E2');
    expect(neighbor(v, 'E2', 'right')).toBe('G2');
    expect(neighbor(v, 'G2', 'right')).toBeNull();
    expect(neighbor(v, 'G2', 'left')).toBe('E2');
    expect(neighbor(v, 'G2', 'down')).toBe('E3');
    expect(neighbor(v, 'E3', 'up')).toBe('G2');
    expect(neighbor(v, 'G1', 'up')).toBeNull();
    expect(neighbor(v, 'E1', 'down')).toBeNull();
    expect(neighbor(v, 'nope', 'down')).toBeNull();
  });

  it('roots are siblings of each other', () => {
    const w = buildVisual(D.addEvent(d).doc);
    expect(neighbor(w, 'G1', 'right')).toBe('E5');
  });

  it('reading order is depth first from the top and covers every node once', () => {
    const order = readingOrder(v);
    expect(order).toEqual(['G1', 'E1', 'E2', 'G2', 'E3', 'E4']);
    expect(new Set(order).size).toBe(v.nodes.length);
  });
});
