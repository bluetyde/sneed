import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLesson, type OracleEntry } from '../../src/core/lesson.js';
import { documentHash, modelHash } from '../../src/core/canonical.js';
import { diffModels } from '../../src/core/compare.js';
import { validateModel, validateModelText } from '../../src/core/validate.js';
import { analyzeBuiltin } from '../../src/engines/bdd/analyze.js';
import type { Api, RunResponse, ValidateResponse } from '../../src/web/api.js';
import { Editor } from '../../src/web/model/editor.js';
import { figureSvg, resultLines } from '../../src/web/model/figure.js';
import { buildVisual } from '../../src/web/model/visual.js';
import * as D from '../../src/web/model/doc.js';

// Plan 15, stage C4: common-cause groups in the editor model (no DOM): the document operations, the editor's commands, what the lesson and
// the comparison make of a model with groups, and the whole of lesson 5 done as a student would, with the real built-in engine.

const root = path.join(import.meta.dirname, '..', '..');
const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-ccf-editor-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Four events under an OR, nothing grouped. */
function base(): D.Doc {
  let d = D.emptyModel('Test', '2026-10-25T00:00:00Z');
  d = D.addGate(d, 'or').doc; // G1 with E1, E2
  d = D.addEvent(d, { parent: 'G1' }).doc; // E3
  d = D.addEvent(d, { parent: 'G1' }).doc; // E4
  return d;
}
const valid = (d: D.Doc): boolean => validateModel(JSON.parse(D.serialize(d))).valid;

describe('document operations on groups', () => {
  it('addGroup makes a valid group: one probability for the members, the assumption follows, the id is new', () => {
    let d = D.setProbability(base(), 'E1', 0.2);
    const a = D.addGroup(d, ['E1', 'E2']);
    expect(a.id).toBe('CC1');
    d = a.doc;
    expect(D.groups(d)).toEqual([{ id: 'CC1', method: 'beta-factor', members: ['E1', 'E2'], beta: D.DEFAULT_BETA }]);
    expect(D.findEvent(d, 'E2')!.probability).toBe(0.2); // the first member's
    expect(d.assumptions.independence).toBe('beta-factor-groups');
    expect(valid(d)).toBe(true);
    expect(D.groupOf(d, 'E2')!.id).toBe('CC1');
    expect(D.groupOf(d, 'E3')).toBeUndefined();
    const second = D.addGroup(d, ['E3', 'E4']);
    expect(second.id).toBe('CC2');
    expect(valid(second.doc)).toBe(true);
  });

  it('addGroup refuses what the validator would: fewer than two events, a gate, an event that is already in a group', () => {
    const d = base();
    for (const members of [['E1'], ['E1', 'E1'], ['E1', 'G1'], ['E1', 'ZZ'], []]) expect(D.addGroup(d, members).id, members.join()).toBe('');
    const grouped = D.addGroup(d, ['E1', 'E2']).doc;
    expect(D.addGroup(grouped, ['E2', 'E3']).id).toBe('');
    expect(D.addGroup(d, ['E1', 'E2']).doc).not.toBe(d);
    expect(D.addGroup(d, ['E1']).doc).toBe(d);
  });

  it('a group id never clashes with an event or a gate', () => {
    let d = base();
    d = { ...d, events: [...d.events, { id: 'CC1', probability: 0.1 }] };
    expect(D.addGroup(d, ['E1', 'E2']).id).toBe('CC2');
  });

  it('setProbability on a member sets the whole group, and on any other event only that event', () => {
    const d = D.addGroup(base(), ['E1', 'E2']).doc;
    const set = D.setProbability(d, 'E2', 0.3);
    expect([D.findEvent(set, 'E1')!.probability, D.findEvent(set, 'E2')!.probability]).toEqual([0.3, 0.3]);
    expect(D.findEvent(set, 'E3')!.probability).toBe(D.DEFAULT_PROBABILITY);
    expect(valid(set)).toBe(true);
    expect(D.findEvent(D.setProbability(d, 'E3', 0.4), 'E1')!.probability).toBe(D.DEFAULT_PROBABILITY);
  });

  it('addToGroup takes the group\'s probability; removeFromGroup and removeNode keep the group valid or take it away', () => {
    let d = D.addGroup(D.setProbability(base(), 'E1', 0.25), ['E1', 'E2']).doc;
    d = D.addToGroup(d, 'CC1', 'E3');
    expect(D.findEvent(d, 'E3')!.probability).toBe(0.25);
    expect(D.findGroup(d, 'CC1')!.members).toEqual(['E1', 'E2', 'E3']);
    expect(D.addToGroup(d, 'CC1', 'E3')).toEqual(d); // already in
    expect(valid(d)).toBe(true);
    const out = D.removeFromGroup(d, 'CC1', 'E3');
    expect(D.findGroup(out, 'CC1')!.members).toEqual(['E1', 'E2']);
    expect(valid(out)).toBe(true);
    // a group of two that loses a member is taken away, and the assumption goes back
    const gone = D.removeFromGroup(out, 'CC1', 'E2');
    expect(D.groups(gone)).toEqual([]);
    expect('common_cause_groups' in gone).toBe(false);
    expect(gone.assumptions.independence).toBe('declared-independent');
    expect(valid(gone)).toBe(true);
    // deleting a member event does the same
    const deleted = D.removeNode(out, 'E1');
    expect('common_cause_groups' in deleted).toBe(false);
    expect(valid(deleted)).toBe(true);
    expect(valid(D.removeNode(d, 'E3'))).toBe(true); // a group of three loses one and stays
    expect(D.findGroup(D.removeNode(d, 'E3'), 'CC1')!.members).toEqual(['E1', 'E2']);
  });

  it('removeGroup, setBeta and setGroupName', () => {
    const d = D.addGroup(base(), ['E1', 'E2']).doc;
    expect(D.findGroup(D.setBeta(d, 'CC1', 0.4), 'CC1')!.beta).toBe(0.4);
    expect(D.findGroup(D.setGroupName(d, 'CC1', 'Pumps'), 'CC1')!.name).toBe('Pumps');
    expect('name' in D.findGroup(D.setGroupName(D.setGroupName(d, 'CC1', 'Pumps'), 'CC1', ''), 'CC1')!).toBe(false);
    const removed = D.removeGroup(d, 'CC1');
    expect('common_cause_groups' in removed).toBe(false);
    expect(removed.assumptions.independence).toBe('declared-independent');
    expect(D.findEvent(removed, 'E1')).toBeDefined(); // the events stay
  });

  it('no operation changes the document it is given, and a group keeps unknown fields', () => {
    const d = D.addGroup(base(), ['E1', 'E2']).doc;
    const before = JSON.stringify(d);
    D.setBeta(d, 'CC1', 0.5);
    D.addToGroup(d, 'CC1', 'E3');
    D.removeFromGroup(d, 'CC1', 'E1');
    D.removeGroup(d, 'CC1');
    D.setProbability(d, 'E1', 0.9);
    D.removeNode(d, 'E2');
    expect(JSON.stringify(d)).toBe(before);
    const withField = { ...d, common_cause_groups: [{ ...D.findGroup(d, 'CC1')!, 'x-note': 'kept' }] } as D.Doc;
    expect(D.findGroup(D.setBeta(withField, 'CC1', 0.2), 'CC1')!['x-note']).toBe('kept');
  });

  it('a model that was saved with groups opens with them (parseDoc keeps the list)', () => {
    const d = D.addGroup(base(), ['E1', 'E2']).doc;
    expect(D.groups(D.parseDoc(D.serialize(d)))).toEqual(D.groups(d));
  });
});

describe('the drawing of a model with groups', () => {
  it('the group does not change where the nodes are, and the visual still draws every node once', () => {
    const plain = base();
    const grouped = D.addGroup(plain, ['E1', 'E2']).doc;
    const a = buildVisual(plain);
    const b = buildVisual(grouped);
    expect(b.nodes.map((n) => [n.key, n.x, n.y])).toEqual(a.nodes.map((n) => [n.key, n.x, n.y]));
  });

  it('the printable figure names the group, boxes it, and says the events are not all independent; a model without groups is unchanged', () => {
    const plain = base();
    const grouped = D.setGroupName(D.addGroup(plain, ['E1', 'E2']).doc, 'CC1', 'Pumps');
    const svg = figureSvg(grouped);
    expect(svg).toContain('Common-cause group Pumps: E1, E2; beta 0.1.');
    expect(svg).toContain('stroke-dasharray="10 3 2 3"');
    expect(svg).toContain('in Pumps');
    expect(svg).toContain('Dash-dot rectangle: a common-cause group.');
    expect(svg).toContain('except the members of each common-cause group');
    const plainSvg = figureSvg(plain);
    expect(plainSvg).not.toContain('common-cause');
    expect(plainSvg).not.toContain('10 3 2 3');
    expect(plainSvg).toContain('basic events independent, as declared by the model');
  });

  it('the result block of the figure says a result with groups is a different kind, and gives the independent value', () => {
    const rec = { status: 'completed', completeness: 'complete', method: 'exact', reasons: [], engine: { name: 'sneed-bdd', version: '0.1.0' }, top_event_probability: 0.018019, minimal_cut_sets: [], caveats: [], input_hashes: { model_hash: 'a'.repeat(64) }, common_cause: { method: 'beta-factor', groups: [], independent_value: 0.01, note: 'n' } };
    const lines = resultLines({ record: rec as never, stale: false });
    expect(lines.join('\n')).toContain('Common-cause groups used (beta-factor): this is a different kind of result');
    expect(lines.join('\n')).toContain('would give 0.01.');
    const without = resultLines({ record: { ...rec, common_cause: { ...rec.common_cause, independent_value: null } } as never, stale: false });
    expect(without.join('\n')).not.toContain('would give');
  });
});

describe('comparing two models', () => {
  it('a difference in the groups is a difference in the model', () => {
    const plain = JSON.parse(D.serialize(base()));
    const grouped = JSON.parse(D.serialize(D.addGroup(base(), ['E1', 'E2']).doc));
    const d = diffModels(plain, grouped)!;
    expect(d.identical).toBe(false);
    expect(d.groups.added).toEqual(['CC1']);
    expect(diffModels(grouped, plain)!.groups.removed).toEqual(['CC1']);
    const beta = diffModels(grouped, JSON.parse(D.serialize(D.setBeta(D.addGroup(base(), ['E1', 'E2']).doc, 'CC1', 0.3))))!;
    expect(beta.identical).toBe(false);
    expect(beta.groups.changed).toEqual([{ id: 'CC1', beta: { from: 0.1, to: 0.3 }, members: null }]);
    const members = diffModels(grouped, JSON.parse(D.serialize(D.addToGroup(D.addGroup(base(), ['E1', 'E2']).doc, 'CC1', 'E3'))))!;
    expect(members.groups.changed[0]!.members).toEqual({ from: ['E1', 'E2'], to: ['E1', 'E2', 'E3'] });
  });

  it('two models with the same groups, and a model without groups on both sides, stay identical', () => {
    const g = JSON.parse(D.serialize(D.addGroup(base(), ['E1', 'E2']).doc));
    expect(diffModels(g, structuredClone(g))!.identical).toBe(true);
    const p = JSON.parse(D.serialize(base()));
    expect(diffModels(p, structuredClone(p))!.identical).toBe(true);
    expect(diffModels(p, p)!.groups).toEqual({ added: [], removed: [], changed: [] });
    // the order of the members is not a difference
    const swapped = structuredClone(g);
    swapped.common_cause_groups[0].members.reverse();
    expect(diffModels(g, swapped)!.identical).toBe(true);
  });
});

/** An API for the editor: it validates as the server does and runs the real built-in engine, so what the editor shows is a real result. */
function realApi(lessonText: string): Api {
  const oracles = ['oracles.json', 'oracles-common-cause.json'].flatMap((f) => JSON.parse(readFileSync(path.join(root, 'tests', f), 'utf8')) as OracleEntry[]);
  const lesson = loadLesson(lessonText, oracles);
  let n = 0;
  return {
    health: async () => ({ name: 'sneed', runtime: { installed: false } }),
    validate: async (text: string) => {
      const v = validateModelText(text);
      let model_hash: string | null = null;
      try {
        model_hash = modelHash(JSON.parse(text));
      } catch {
        model_hash = null;
      }
      return { ...v, model_hash, document_hash: documentHash(Buffer.from(text, 'utf8')) } as ValidateResponse;
    },
    run: async (text: string): Promise<RunResponse> => {
      const out = await analyzeBuiltin(text, { runsDir: temp(), runId: `lesson-run-${String(++n).padStart(4, '0')}` });
      if (out.kind !== 'ran') return { kind: 'refused', errors: out.errors as never, warnings: [] };
      return { kind: 'ran', run_id: path.basename(out.runDir), record: out.record };
    },
    cancel: async () => ({ cancelled: true }),
    lookupRun: async () => ({ found: false }),
    runStatus: async () => ({ running: null, queued: [] }),
    lessons: async () => [lesson],
    listModels: async () => [],
    listRuns: async () => [],
  } as unknown as Api;
}

describe('the editor with common-cause groups', () => {
  const editor = async (): Promise<Editor> => {
    const ed = new Editor(realApi(readFileSync(path.join(root, 'lessons', '05-common-cause.json'), 'utf8')), { debounceMs: 0 });
    await ed.loadLessons();
    return ed;
  };

  it('makeGroup, undo and redo, selection of a group, and the group labels', async () => {
    const ed = await editor();
    ed.doc = base();
    ed.select('E1');
    const id = ed.makeGroup('E1', 'E2');
    expect(id).toBe('CC1');
    expect(ed.selectedGroup).toBe('CC1');
    expect(ed.selected).toBeNull();
    expect(ed.undoLabel).toMatch(/common-cause group CC1/);
    ed.undo();
    expect(D.groups(ed.doc)).toEqual([]);
    expect(ed.selectedGroup).toBeNull(); // the group is gone, so it is not selected any more
    ed.redo();
    expect(D.groups(ed.doc)).toHaveLength(1);
    expect(ed.groupLabel('CC1')).toBe('CC1');
    ed.setGroupName('CC1', 'Pumps');
    expect(ed.groupLabel('CC1')).toBe('Pumps');
    ed.select('E3');
    expect(ed.selectedGroup).toBeNull(); // choosing a node leaves the group
    ed.selectGroup('CC1');
    expect(ed.selected).toBeNull();
    ed.selectGroup('nope');
    expect(ed.selectedGroup).toBeNull();
  });

  it('Delete on a selected group deletes the group and keeps the events', async () => {
    const ed = await editor();
    ed.doc = base();
    ed.makeGroup('E1', 'E2');
    ed.deleteSelected();
    expect(D.groups(ed.doc)).toEqual([]);
    expect(D.findEvent(ed.doc, 'E1')).toBeDefined();
    expect(ed.selectedGroup).toBeNull();
  });

  it('setBeta refuses a number that is not one; the range is the validator\'s and the panel\'s', async () => {
    const ed = await editor();
    ed.doc = base();
    ed.makeGroup('E1', 'E2');
    expect(ed.setBeta('CC1', Number.NaN)).toBe(false);
    expect(ed.setBeta('CC1', 0.25)).toBe(true);
    expect(D.findGroup(ed.doc, 'CC1')!.beta).toBe(0.25);
    ed.setBeta('CC1', 2);
    await ed.revalidate();
    expect(ed.problems.map((p) => p.code)).toContain('E_CCF_BETA_RANGE');
    ed.selectIssue(ed.problems.find((p) => p.code === 'E_CCF_BETA_RANGE')!);
    expect(ed.selectedGroup).toBe('CC1'); // a problem that names a group selects it
  });

  it('ungroupedEvents lists the events that can still join a group', async () => {
    const ed = await editor();
    ed.doc = base();
    expect(ed.ungroupedEvents.map((e) => e.id)).toEqual(['E1', 'E2', 'E3', 'E4']);
    ed.makeGroup('E1', 'E2');
    expect(ed.ungroupedEvents.map((e) => e.id)).toEqual(['E3', 'E4']);
    expect(ed.makeGroup('E1', 'E3')).toBe(''); // E1 is in a group already
  });

  it('a cut set of a model with groups is explained in words', async () => {
    const ed = await editor();
    ed.doc = base();
    ed.makeGroup('E1', 'E2');
    ed.setName('E1', 'Pump A');
    ed.setGroupName('CC1', 'Pumps');
    expect(ed.describeCutSet(['CC1.CCF'])).toBe('The top event occurs if the common cause of group Pumps fails.');
    expect(ed.describeCutSet(['E1.independent', 'E2.independent'])).toBe('The top event occurs if Pump A on its own and E2 on its own both fail.');
  });

  it('lesson 5, done as a student does with the real built-in engine: AND without and with a group, then OR', async () => {
    const ed = await editor();
    expect(ed.startLesson('05-common-cause')).toBe(true);
    ed.addGate('and'); // G1 = E1 AND E2, the top
    ed.setName('E1', 'A');
    ed.setName('E2', 'B');
    await ed.revalidate();
    let p = ed.lessonProgress!;
    expect(p.steps.map((s) => s.done)).toEqual([true, true, false, false]);

    // independent pumps: not a lesson outcome (it is lesson 2's)
    await ed.run();
    expect(ed.result?.kind === 'ran' && ed.result.record.top_event_probability).toBeCloseTo(0.01, 12);
    expect(ed.lessonProgress!.outcome).toBeNull();

    // the group
    ed.makeGroup('E1', 'E2');
    ed.setGroupName('CC1', 'G');
    await ed.revalidate();
    p = ed.lessonProgress!;
    expect(p.steps.map((s) => s.done)).toEqual([true, true, true, false]);
    expect(ed.stale).toBe(true); // the earlier result is not the result for this model
    expect(ed.lessonProgress!.outcome).toBeNull(); // and a stale result is never graded
    await ed.run();
    const rec = ed.result?.kind === 'ran' ? ed.result.record : null;
    expect(rec!.top_event_probability).toBeCloseTo(0.018019, 12);
    expect(rec!.common_cause!.independent_value).toBeCloseTo(0.01, 12); // the answer to read against
    expect(rec!.minimal_cut_sets.map((c) => c.events.slice().sort().join('+')).sort()).toEqual(['CC1.CCF', 'E1.independent+E2.independent']); // the record uses ids; the lesson reads them through the names
    p = ed.lessonProgress!;
    expect(p.outcome).toBe('and-with-group'); // the names of the events and of the group are the ones the lesson asks for
    expect(p.complete).toBe(false); // the last step (OR) is still to do

    // the gate becomes OR
    ed.setGateType('G1', 'or');
    await ed.revalidate();
    await ed.run();
    expect(ed.result?.kind === 'ran' && ed.result.record.top_event_probability).toBeCloseTo(0.180181, 12);
    expect(ed.result?.kind === 'ran' && ed.result.record.common_cause!.independent_value).toBeCloseTo(0.19, 12);
    p = ed.lessonProgress!;
    expect(p.outcome).toBe('or-with-group');
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.mistakes).toEqual([]);
    expect(p.complete).toBe(true);
  });

  it('a student who leaves the group unnamed does not get the outcome, because the lesson finds things by name', async () => {
    const ed = await editor();
    ed.startLesson('05-common-cause');
    ed.addGate('or');
    ed.setName('E1', 'A');
    ed.setName('E2', 'B');
    ed.makeGroup('E1', 'E2'); // left as CC1, not G
    await ed.revalidate();
    await ed.run();
    expect(ed.lessonProgress!.outcome).toBeNull();
    expect(ed.lessonProgress!.complete).toBe(false);
  });
});
