import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { documentHash, modelHash } from '../../src/core/canonical.js';
import { eventTreeHash, validateEventTreeText, type ModelRef } from '../../src/core/event-tree.js';
import { pathKey } from '../../src/core/event-tree-paths.js';
import { validateModelText } from '../../src/core/validate.js';
import { EVENT_TREE_RESULT_SCHEMA, type EventTreeResult } from '../../src/core/event-tree-result.js';
import { ApiError, type EtApi, type EtRunResponse, type ModelInfo, type ValidateResponse } from '../../src/web/api.js';
import * as E from '../../src/web/model/event-tree-doc.js';
import { EventTreeEditor } from '../../src/web/model/event-tree-editor.js';
import { computeEventTree } from '../../src/engines/bdd/event-tree.js';
import { parseEtLesson, type EtLesson } from '../../src/core/event-tree-lesson.js';
import type { NativeModel } from '../../src/core/model.js';

const NOW = '2026-10-06T00:00:00Z';
const modelText = (p: number): string =>
  JSON.stringify({
    schema: { id: 'sneed.fault-tree', version: 1 },
    model: { id: 'm', name: 'Shared', created: NOW, updated: NOW },
    assumptions: { probability_model: 'constant', independence: 'declared-independent', coherence: 'coherent', time: 'none' },
    top: 'TOP',
    events: [{ id: 'S', probability: p }, { id: 'a', probability: 0.2 }, { id: 'b', probability: 0.3 }],
    gates: [{ id: 'X', type: 'or', inputs: ['S', 'a'] }, { id: 'Y', type: 'or', inputs: ['S', 'b'] }, { id: 'TOP', type: 'and', inputs: ['X', 'Y'] }],
  });
const refOf = (text: string): ModelRef => {
  const m = JSON.parse(text) as { events: { id: string }[]; gates: { id: string }[] };
  return { hash: modelHash(JSON.parse(text)), events: new Set(m.events.map((e) => e.id)), gates: new Set(m.gates.map((g) => g.id)) };
};

/** An API that checks for real (the server's validators) and lets each test script the analysis. */
function fakeApi(over: Partial<EtApi> = {}): EtApi & { models: Map<string, string>; trees: Map<string, string>; calls: string[] } {
  const models = new Map<string, string>([['shared', modelText(0.1)]]);
  const trees = new Map<string, string>();
  const calls: string[] = [];
  const info = (name: string, text: string): ModelInfo => ({ name, bytes: text.length, modified: NOW });
  const api: EtApi = {
    validateEventTree: async (text) => {
      calls.push('validate');
      const v = validateEventTreeText(text, { resolveModel: (n) => (models.has(n) ? refOf(models.get(n)!) : null) });
      return { ...v, tree_hash: v.valid ? eventTreeHash(JSON.parse(text)) : null, document_hash: documentHash(Buffer.from(text, 'utf8')) };
    },
    runEventTree: async (text, approximation): Promise<EtRunResponse> => {
      calls.push(`run:${approximation}`);
      return { kind: 'ran', run_id: 'r1', record: recordFor(text, approximation) };
    },
    cancel: async () => ({ cancelled: true }),
    runStatus: async () => ({ running: null, queued: [] }),
    eventTreeLessons: async () => [],
    saveModel: async (name, text) => {
      models.set(name, text);
      return info(name, text);
    },
    listEventTreeRuns: async () => [],
    loadEventTreeRun: async (id) => {
      throw new ApiError(404, 'E_NOT_FOUND', `no saved run called ${id}`);
    },
    listEventTrees: async () => [...trees].map(([n, t]) => info(n, t)),
    loadEventTree: async (name) => {
      if (!trees.has(name)) throw new ApiError(404, 'E_NOT_FOUND', `no saved event tree called ${name}`);
      return trees.get(name)!;
    },
    saveEventTree: async (name, text) => {
      trees.set(name, text);
      return info(name, text);
    },
    listModels: async () => [...models].map(([n, t]) => info(n, t)),
    loadModel: async (name) => {
      if (!models.has(name)) throw new ApiError(404, 'E_NOT_FOUND', `no saved model called ${name}`);
      return models.get(name)!;
    },
    validate: async (text): Promise<ValidateResponse> => {
      const v = validateModelText(text);
      return { ...v, model_hash: v.valid ? modelHash(JSON.parse(text)) : null, document_hash: documentHash(Buffer.from(text, 'utf8')) } as ValidateResponse;
    },
    ...over,
  };
  return Object.assign(api, { models, trees, calls });
}

function recordFor(text: string, approximation: boolean): EventTreeResult {
  const doc = JSON.parse(text) as E.EtDoc;
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
    input_hashes: { tree_hash: eventTreeHash(doc as never), model_hash: doc.fault_tree_model.model_hash, document_hash: 'd' },
    initiating_event: { name: doc.initiating_event.name, frequency: doc.initiating_event.frequency, unit: 'per-year' },
    headings: doc.headings.map((h) => ({ id: h.id, name: h.name, event: h.event })),
    sequences: [],
    end_states: [],
    total: { frequency: doc.initiating_event.frequency, probability_sum: 1, partition_error: 0 },
    approximation: approximation ? { method: 'success-branches-ignored', note: 'n', frequency_sum: 1 } : null,
    warnings: [],
    caveats: [],
  };
}

const ref = { name: 'shared', hash: modelHash(JSON.parse(modelText(0.1))), top: 'TOP' };
const validate = (doc: E.EtDoc) => validateEventTreeText(E.serialize(doc), { resolveModel: (n) => (n === 'shared' ? refOf(modelText(0.1)) : null) });

describe('event-tree document operations', () => {
  it('a new tree has one heading, two sequences with no end state yet, and the V1 assumptions', () => {
    const d = E.newEventTree(ref, 'T', NOW);
    expect(d.headings).toHaveLength(1);
    expect(d.sequences.map((s) => pathKey(s.path))).toEqual(['H1:works', 'H1:fails']);
    expect(d.sequences.every((s) => s.end_state === '')).toBe(true);
    expect(d.assumptions).toEqual(E.V1_ASSUMPTIONS);
    expect(validate(d).errors.map((e) => e.code)).toEqual(['E_NO_END_STATE', 'E_NO_END_STATE']);
  });

  it('headings add up to the ceiling and no further; the last heading cannot be removed', () => {
    let d = E.newEventTree(ref, 'T', NOW);
    for (let i = 0; i < 20; i++) d = E.addHeading(d, 'TOP', NOW);
    expect(d.headings).toHaveLength(12);
    expect(d.sequences).toHaveLength(4096);
    let one = E.newEventTree(ref, 'T', NOW);
    one = E.removeHeading(one, 'H1', NOW);
    expect(one.headings).toHaveLength(1);
    let none = E.newEventTree(ref, 'T', NOW);
    none = E.removeEndState(none, 'ES1', NOW);
    expect(none.end_states).toHaveLength(1);
  });

  it('a new heading gets an id no existing heading has, whatever was removed before', () => {
    let d = E.newEventTree(ref, 'T', NOW);
    d = E.addHeading(d, 'TOP', NOW); // H2
    d = E.removeHeading(d, 'H1', NOW);
    d = E.addHeading(d, 'TOP', NOW);
    expect(d.headings.map((h) => h.id)).toEqual(['H2', 'H3']);
  });

  it('removing a heading drops the conditions that named it; moving one above its own condition drops that condition', () => {
    let d = E.newEventTree(ref, 'T', NOW);
    d = E.addHeading(d, 'TOP', NOW);
    d = E.setBypass(d, 'H2', { heading: 'H1', branch: 'works' }, NOW);
    expect(d.sequences).toHaveLength(3);
    const moved = E.moveHeading(d, 'H2', -1, NOW);
    expect(moved.headings.map((h) => h.id)).toEqual(['H2', 'H1']);
    expect(moved.headings.every((h) => !h.asked_only_if)).toBe(true);
    expect(moved.sequences).toHaveLength(4);
    const removed = E.removeHeading(d, 'H1', NOW);
    expect(removed.headings[0]!.asked_only_if).toBeUndefined();
    expect(removed.sequences).toHaveLength(2);
  });

  it('a path that still exists keeps its end state; a path that does not exist is gone and new paths have none', () => {
    let d = E.newEventTree(ref, 'T', NOW);
    d = E.setUnsetEnds(d, 'ES1', NOW);
    d = E.patchHeading(d, 'H1', { name: 'Renamed' }, NOW);
    expect(d.sequences.map((s) => s.end_state)).toEqual(['ES1', 'ES1']);
    d = E.addHeading(d, 'TOP', NOW); // every path now has two steps: nothing carries over
    expect(d.sequences.every((s) => s.end_state === '')).toBe(true);
  });

  it('after a change to when a heading is asked, the paths that survive keep their end state and the new one has none', () => {
    let d = E.addHeading(E.newEventTree(ref, 'T', NOW), 'TOP', NOW);
    d = E.addEndState(d, NOW);
    d = E.setUnsetEnds(d, 'ES2', NOW);
    d = E.setSequenceEnd(d, 'H1:works,H2:works', 'ES1', NOW);
    d = E.setBypass(d, 'H2', { heading: 'H1', branch: 'works' }, NOW);
    expect(d.sequences.map((s) => [pathKey(s.path), s.end_state])).toEqual([['H1:works,H2:works', 'ES1'], ['H1:works,H2:fails', 'ES2'], ['H1:fails', '']]);
  });

  it('giving the unset sequences an end state leaves the chosen ones alone', () => {
    let d = E.addEndState(E.newEventTree(ref, 'T', NOW), NOW);
    d = E.setSequenceEnd(d, 'H1:fails', 'ES2', NOW);
    d = E.setUnsetEnds(d, 'ES1', NOW);
    expect(d.sequences.map((s) => s.end_state)).toEqual(['ES1', 'ES2']);
  });

  it('removing an end state leaves its sequences without one, never pointing at a state that is gone', () => {
    let d = E.newEventTree(ref, 'T', NOW);
    d = E.addEndState(d, NOW);
    d = E.setUnsetEnds(d, 'ES2', NOW);
    d = E.removeEndState(d, 'ES2', NOW);
    expect(d.sequences.every((s) => s.end_state === '')).toBe(true);
    expect(validate(E.setUnsetEnds(d, 'ES1', NOW)).valid).toBe(true);
  });

  it('whatever sequence of edits is made, giving the unset sequences an end state leaves a document the validator accepts', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      let d = E.newEventTree(ref, 'T', NOW);
      for (let step = 0; step < 25; step++) {
        const ids = d.headings.map((h) => h.id);
        const pick = ids[rnd(ids.length)]!;
        switch (rnd(7)) {
          case 0: d = d.headings.length < 6 ? E.addHeading(d, 'X', NOW) : d; break;
          case 1: d = E.removeHeading(d, pick, NOW); break;
          case 2: d = E.moveHeading(d, pick, rnd(2) ? 1 : -1, NOW); break;
          case 3: {
            const i = ids.indexOf(pick);
            d = i === 0 ? E.setBypass(d, pick, null, NOW) : E.setBypass(d, pick, { heading: ids[rnd(i)]!, branch: rnd(2) ? 'works' : 'fails' }, NOW);
            break;
          }
          case 4: d = E.addEndState(d, NOW); break;
          case 5: d = E.removeEndState(d, d.end_states[rnd(d.end_states.length)]!.id, NOW); break;
          default: d = E.setSequenceEnd(d, pathKey(d.sequences[rnd(d.sequences.length)]!.path), d.end_states[rnd(d.end_states.length)]!.id, NOW);
        }
      }
      const done = E.setUnsetEnds(d, d.end_states[0]!.id, NOW);
      const v = validate(done);
      expect(v.errors, `round ${round}: ${E.serialize(done)}`).toEqual([]);
    }
  });

  it('an edit stamps the updated time and leaves the created time alone', () => {
    const d = E.newEventTree(ref, 'T', NOW);
    const later = '2026-10-07T00:00:00Z';
    for (const e of [E.setTreeName(d, 'x', later), E.addHeading(d, 'TOP', later), E.addEndState(d, later), E.setInitiating(d, { frequency: 1 }, later), E.setBypass(d, 'H1', null, later)]) {
      expect(e.tree.updated).toBe(later);
      expect(e.tree.created).toBe(NOW);
    }
  });

  it('a bypass is stored as the condition given, and cleared by null', () => {
    let d = E.addHeading(E.newEventTree(ref, 'T', NOW), 'TOP', NOW);
    d = E.setBypass(d, 'H2', { heading: 'H1', branch: 'fails' }, NOW);
    expect(d.headings[1]!.asked_only_if).toEqual({ heading: 'H1', branch: 'fails' });
    expect(d.sequences.map((s) => pathKey(s.path))).toEqual(['H1:works', 'H1:fails,H2:works', 'H1:fails,H2:fails']);
    d = E.setBypass(d, 'H2', null, NOW);
    expect(d.headings[1]!.asked_only_if).toBeUndefined();
    expect(d.sequences).toHaveLength(4);
  });

  it('operations never change their input', () => {
    const d = E.newEventTree(ref, 'T', NOW);
    const before = E.serialize(d);
    E.addHeading(d, 'TOP', NOW);
    E.setBypass(E.addHeading(d, 'TOP', NOW), 'H2', { heading: 'H1', branch: 'works' }, NOW);
    E.setUnsetEnds(d, 'ES1', NOW);
    E.patchEndState(d, 'ES1', { synthetic: false }, NOW);
    expect(E.serialize(d)).toBe(before);
  });
});

describe('EventTreeEditor', () => {
  const make = async (over: Partial<EtApi> = {}) => {
    const api = fakeApi(over);
    const ed = new EventTreeEditor(api, { debounceMs: 0, now: () => NOW });
    await ed.newTree();
    await ed.settle();
    return { api, ed };
  };

  it('a new tree adopts the first saved model, names its events and is blocked until every sequence has an end state', async () => {
    const { ed } = await make();
    expect(ed.doc.fault_tree_model.name).toBe('shared');
    expect(ed.model?.events.map((e) => e.id)).toEqual(['S', 'a', 'b']);
    expect(ed.model?.gates.map((g) => g.id)).toEqual(['X', 'Y', 'TOP']);
    expect(ed.unsetEnds).toBe(2);
    expect(ed.canRun).toBe(false);
    expect(ed.runBlockedReason).toMatch(/2 problems to fix/);
    ed.setUnsetEnds('ES1');
    await ed.settle();
    expect(ed.canRun).toBe(true);
    expect(ed.runBlockedReason).toBeNull();
  });

  it('with no saved model it still opens, and says what is missing instead of running', async () => {
    const api = fakeApi();
    api.models.clear();
    const ed = new EventTreeEditor(api, { debounceMs: 0, now: () => NOW });
    await ed.newTree();
    await ed.settle();
    expect(ed.model).toBeNull();
    expect(ed.validation?.errors.map((e) => e.code)).toContain('E_MODEL_NOT_FOUND');
    expect(ed.canRun).toBe(false);
  });

  it('changing the headings says when end-state choices were dropped, and not otherwise', async () => {
    const { ed } = await make();
    ed.setUnsetEnds('ES1');
    ed.setNotice(null);
    ed.patchHeading('H1', { name: 'New name' });
    expect(ed.notice).toBeNull();
    ed.addHeading();
    expect(ed.notice?.text).toMatch(/2 end state choices were dropped/);
    ed.setNotice(null);
    ed.removeHeading('H2'); // the paths are back to H1:works, H1:fails, which had no end states
    expect(ed.notice).toBeNull();
  });

  it('a result is current only for the tree and the approximation setting it was made with', async () => {
    const { ed, api } = await make();
    ed.setUnsetEnds('ES1');
    await ed.settle();
    await ed.run();
    expect(api.calls).toContain('run:false');
    expect(ed.result?.kind).toBe('ran');
    expect(ed.stale).toBe(false);
    ed.setApproximation(true);
    expect(ed.stale).toBe(true);
    await ed.run();
    expect(api.calls).toContain('run:true');
    expect(ed.stale).toBe(false);
    ed.setInitiating({ frequency: 0.7 });
    expect(ed.stale).toBe(true); // true at once: the check for the new text has not come back, and a result must not look current meanwhile
    await ed.settle();
    expect(ed.stale).toBe(true);
    ed.setInitiating({ name: 'Renamed event', description: 'words only' });
    ed.setInitiating({ frequency: 0.1 });
    await ed.settle();
    expect(ed.stale).toBe(false); // back to the same meaning: the same hash
  });

  it('a name or description change alone does not make a result stale', async () => {
    const { ed } = await make();
    ed.setUnsetEnds('ES1');
    await ed.settle();
    await ed.run();
    ed.setTreeName('Another title');
    ed.setInitiating({ description: 'a different sentence' });
    await ed.settle();
    expect(ed.stale).toBe(false);
  });

  it('a tree that was valid is not runnable the moment it is edited, until the new text has been checked', async () => {
    const { ed } = await make();
    ed.setUnsetEnds('ES1');
    await ed.settle();
    expect(ed.canRun).toBe(true);
    ed.setInitiating({ frequency: 0.3 });
    expect(ed.canRun).toBe(false);
    expect(ed.runBlockedReason).toMatch(/not been checked/);
    await ed.settle();
    expect(ed.canRun).toBe(true);
  });

  it('a run is refused while the text on screen has not been checked, and while a run is in progress', async () => {
    let release: (r: EtRunResponse) => void = () => undefined;
    let asked = 0;
    const { ed } = await make({
      runEventTree: () => {
        asked++;
        return new Promise<EtRunResponse>((res) => (release = res));
      },
    });
    ed.setUnsetEnds('ES1');
    expect(ed.canRun).toBe(false); // edited, not yet checked
    await ed.settle();
    const first = ed.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(ed.running).toBe(true);
    await ed.run(); // ignored, and says nothing
    expect(asked).toBe(1);
    expect(ed.notice).toBeNull();
    release({ kind: 'ran', run_id: 'r', record: recordFor(ed.text, false) });
    await first;
    expect(ed.running).toBe(false);
    expect(ed.result?.kind).toBe('ran');
  });

  it('cancelling passes this run\'s request id, and a dequeued answer says nothing was run', async () => {
    let seen: string | undefined;
    let cancelled: string | undefined;
    let release: (r: EtRunResponse) => void = () => undefined;
    const { ed } = await make({
      runEventTree: (_t, _a, requestId) => {
        seen = requestId;
        return new Promise<EtRunResponse>((res) => (release = res));
      },
      cancel: async (id) => {
        cancelled = id;
        return { cancelled: true };
      },
    });
    ed.setUnsetEnds('ES1');
    await ed.settle();
    const p = ed.run();
    await new Promise((r) => setTimeout(r, 5));
    await ed.cancel();
    expect(seen).toMatch(/^e/);
    expect(cancelled).toBe(seen);
    release({ kind: 'dequeued' });
    await p;
    expect(ed.result).toBeNull();
    expect(ed.notice?.text).toMatch(/Nothing was run/);
  });

  it('while waiting its turn, the queue position is shown', async () => {
    EventTreeEditor.queuePollMs = 5;
    let release: (r: EtRunResponse) => void = () => undefined;
    let id = '';
    const { ed } = await make({
      runEventTree: (_t, _a, requestId) => {
        id = requestId ?? '';
        return new Promise<EtRunResponse>((res) => (release = res));
      },
      runStatus: async () => ({ running: { request_id: 'other' }, queued: [{ request_id: 'x' }, { request_id: id }] }),
    });
    try {
      ed.setUnsetEnds('ES1');
      await ed.settle();
      const p = ed.run();
      await new Promise((r) => setTimeout(r, 40));
      expect(ed.queueAhead).toBe(2);
      release({ kind: 'dequeued' });
      await p;
      expect(ed.queueAhead).toBe(0);
    } finally {
      EventTreeEditor.queuePollMs = 700;
    }
  });

  it('a server error is shown as the error, not as a result', async () => {
    const { ed } = await make({ runEventTree: async () => { throw new ApiError(409, 'E_BUSY', '8 runs are already waiting'); } });
    ed.setUnsetEnds('ES1');
    await ed.settle();
    await ed.run();
    expect(ed.runError).toMatch(/E_BUSY/);
    expect(ed.result).toBeNull();
    expect(ed.running).toBe(false);
  });

  it('save then open gives the same document; a bad file is refused with the reason', async () => {
    const { ed, api } = await make();
    ed.setUnsetEnds('ES1');
    expect(await ed.save()).toBe(false); // no name yet
    expect(await ed.save('t1')).toBe(true);
    expect(ed.dirty).toBe(false);
    const saved = api.trees.get('t1')!;
    const other = new EventTreeEditor(api, { debounceMs: 0, now: () => NOW });
    expect(await other.open('t1')).toBe(true);
    expect(other.text).toBe(saved);
    api.trees.set('bad', '{"headings": 3}');
    expect(await other.open('bad')).toBe(false);
    expect(other.notice?.kind).toBe('error');
    expect(await other.open('missing')).toBe(false);
    expect(other.fileName).toBe('t1'); // a failed open changes nothing
  });

  it('a model saved again is noticed, named stale by the check, and adopted only when the author says so', async () => {
    const { ed, api } = await make();
    ed.setUnsetEnds('ES1');
    await ed.settle();
    expect(ed.modelChanged).toBe(false);
    api.models.set('shared', modelText(0.2));
    await ed.refreshContext();
    expect(ed.modelChanged).toBe(true);
    expect(ed.validation?.errors.map((e) => e.code)).toContain('E_STALE_MODEL');
    expect(ed.canRun).toBe(false);
    await ed.adoptCurrentModel();
    await ed.settle();
    expect(ed.modelChanged).toBe(false);
    expect(ed.validation?.valid).toBe(true);
  });

  it('choosing a model that is not valid is refused and changes nothing', async () => {
    const { ed, api } = await make();
    api.models.set('broken', '{"top": "T"}');
    const before = ed.text;
    await ed.chooseModel('broken');
    expect(ed.text).toBe(before);
    expect(ed.notice?.kind).toBe('error');
    await ed.chooseModel('nope');
    expect(ed.text).toBe(before);
  });

  it('an out-of-date answer about the model does not overwrite a newer choice', async () => {
    const { ed, api } = await make();
    api.models.set('other', modelText(0.3));
    const slow = new Promise<void>((r) => setTimeout(r, 20));
    const realLoad = api.loadModel;
    api.loadModel = async (n) => {
      if (n === 'shared') await slow;
      return realLoad(n);
    };
    const first = ed.loadModelInfo(); // asks about "shared", slowly
    await ed.chooseModel('other');
    await first;
    expect(ed.model?.name).toBe('other');
  });

  it('an edit made while a save is under way is neither lost nor marked saved', async () => {
    let finish: () => void = () => undefined;
    const { ed, api } = await make();
    ed.setUnsetEnds('ES1');
    await ed.settle();
    const real = api.saveEventTree;
    api.saveEventTree = (n, t) => new Promise((res) => (finish = () => void real(n, t).then(res)));
    const saving = ed.save('t1');
    ed.setInitiating({ frequency: 0.9 }); // typed after the save began
    finish();
    await saving;
    expect(ed.doc.initiating_event.frequency).toBe(0.9);
    expect(ed.dirty).toBe(true);
    expect(JSON.parse(api.trees.get('t1')!).initiating_event.frequency).toBe(0.1);
  });

  it('a save that finishes after another tree was opened does not touch the open one', async () => {
    let finish: () => void = () => undefined;
    const { ed, api } = await make();
    ed.setUnsetEnds('ES1');
    api.trees.set('other', E.serialize(E.setUnsetEnds(E.newEventTree(ref, 'Other', NOW), 'ES1', NOW)));
    const real = api.saveEventTree;
    api.saveEventTree = (n, t) => new Promise((res) => (finish = () => void real(n, t).then(res)));
    const saving = ed.save('t1');
    await ed.open('other');
    finish();
    await saving;
    expect(ed.fileName).toBe('other');
    expect(ed.doc.tree.name).toBe('Other');
    expect(ed.dirty).toBe(false);
  });

  it('of two opens the later one wins, whichever answers last', async () => {
    const { ed, api } = await make();
    api.trees.set('a', E.serialize(E.newEventTree(ref, 'A', NOW)));
    api.trees.set('b', E.serialize(E.newEventTree(ref, 'B', NOW)));
    const real = api.loadEventTree;
    api.loadEventTree = async (n) => {
      if (n === 'a') await new Promise((r) => setTimeout(r, 30));
      return real(n);
    };
    const first = ed.open('a');
    await ed.open('b');
    await first;
    expect(ed.fileName).toBe('b');
    expect(ed.doc.tree.name).toBe('B');
  });

  it('a frequency that is not a number blocks analysis, marks the result old, is not saved as if it were whole, and is cleared by a number', async () => {
    const { ed } = await make();
    ed.setUnsetEnds('ES1');
    await ed.settle();
    await ed.run();
    expect(ed.stale).toBe(false);
    ed.setFrequencyText('lots');
    expect(ed.frequencyDraft).toBe('lots');
    expect(ed.doc.initiating_event.frequency).toBe(0.1);
    expect(ed.canRun).toBe(false);
    expect(ed.runBlockedReason).toMatch(/not a number/);
    expect(ed.stale).toBe(true);
    expect(ed.dirty).toBe(true);
    expect(await ed.save('t1')).toBe(false);
    expect(ed.notice?.kind).toBe('warning');
    ed.setFrequencyText('-1');
    expect(ed.frequencyDraft).toBe('-1');
    ed.setFrequencyText('0.25');
    await ed.settle();
    expect(ed.frequencyDraft).toBeNull();
    expect(ed.doc.initiating_event.frequency).toBe(0.25);
    expect(ed.canRun).toBe(true);
  });

  it('a half-typed frequency is unsaved work even when everything else is saved', async () => {
    const { ed } = await make();
    ed.setUnsetEnds('ES1');
    expect(await ed.save('t1')).toBe(true);
    expect(ed.dirty).toBe(false);
    ed.setFrequencyText('0.10');
    expect(ed.frequencyDraft).toBeNull(); // the same number as saved
    expect(ed.dirty).toBe(false);
    ed.setFrequencyText('abc');
    expect(ed.dirty).toBe(true);
  });

  it('opening another tree drops a half-typed frequency', async () => {
    const { ed, api } = await make();
    api.trees.set('a', E.serialize(E.newEventTree(ref, 'A', NOW)));
    ed.setFrequencyText('x');
    await ed.open('a');
    expect(ed.frequencyDraft).toBeNull();
  });

  it('a failure while checking the chosen model is shown, and a slower earlier choice does not override a later one', async () => {
    const { ed, api } = await make();
    api.models.set('other', modelText(0.3));
    api.models.set('third', modelText(0.4));
    const realLoad = api.loadModel;
    api.loadModel = async (n) => {
      if (n === 'other') await new Promise((r) => setTimeout(r, 30));
      return realLoad(n);
    };
    const first = ed.chooseModel('other');
    await ed.chooseModel('third');
    await first;
    expect(ed.doc.fault_tree_model.name).toBe('third');
    const realValidate = api.validate;
    api.validate = async () => {
      throw new Error('server went away');
    };
    ed.setNotice(null);
    await ed.chooseModel('shared');
    expect(ed.notice?.kind).toBe('error');
    expect(ed.doc.fault_tree_model.name).toBe('third');
    api.validate = realValidate;
  });

  it('a cancel that fails is said, not swallowed', async () => {
    let release: (r: EtRunResponse) => void = () => undefined;
    const { ed } = await make({
      runEventTree: () => new Promise<EtRunResponse>((res) => (release = res)),
      cancel: async () => {
        throw new Error('no connection');
      },
    });
    ed.setUnsetEnds('ES1');
    await ed.settle();
    const p = ed.run();
    await new Promise((r) => setTimeout(r, 5));
    await ed.cancel();
    expect(ed.notice?.text).toMatch(/Could not cancel/);
    release({ kind: 'dequeued' });
    await p;
  });

  const savedRecord = (total: number): unknown => ({
    schema: { id: 'sneed.event-tree-result', version: 1 },
    status: 'completed',
    completeness: 'complete',
    headings: [],
    sequences: [{ key: 'H1:works', path: [{ heading: 'H1', branch: 'works' }], end_state: 'ES1', frequency: total }],
    end_states: [{ id: 'ES1', name: 'x', frequency: total }],
    total: { frequency: total },
    input_hashes: { tree_hash: 't', model_hash: 'm' },
    initiating_event: { name: 'IE', frequency: 1 },
  });

  it('lists the saved analyses, and says so when the list cannot be read', async () => {
    const { ed, api } = await make();
    api.listEventTreeRuns = async () => [{ id: 'r1', modified: NOW, status: 'completed', completeness: 'complete', tree_name: 'T', initiating_event: 'IE', frequency: 1, total_frequency: 1, tree_hash: 't', model_hash: 'm', engine_name: 'e', engine_version: '1' }];
    await ed.refreshRuns();
    expect(ed.runs.map((r) => r.id)).toEqual(['r1']);
    expect(ed.runsError).toBeNull();
    api.listEventTreeRuns = async () => {
      throw new Error('down');
    };
    await ed.refreshRuns();
    expect(ed.runs).toEqual([]);
    expect(ed.runsError).toMatch(/Could not list the saved analyses: down/);
  });

  it('a run adds itself to the list, and returning to the view refreshes it', async () => {
    let listed = 0;
    const { ed } = await make({
      listEventTreeRuns: async () => {
        listed++;
        return [];
      },
    });
    const before = listed;
    await ed.refreshContext();
    expect(listed).toBeGreaterThan(before);
    ed.setUnsetEnds('ES1');
    await ed.settle();
    const mid = listed;
    await ed.run();
    await new Promise((r) => setTimeout(r, 5));
    expect(listed).toBeGreaterThan(mid);
  });

  it('compares two saved analyses, and a file that cannot be read or is not a result is named, with no earlier comparison left on show', async () => {
    const files: Record<string, unknown> = { a: savedRecord(1), b: savedRecord(2), junk: { schema: { id: 'sneed.fault-tree' } } };
    const { ed } = await make({
      loadEventTreeRun: async (id) => {
        if (!(id in files)) throw new ApiError(404, 'E_NOT_FOUND', `no saved run called ${id}`);
        return { id, record: files[id] };
      },
    });
    await ed.compare('a', 'b');
    expect(ed.comparison?.diff.total).toMatchObject({ from: 1, to: 2 });
    expect(ed.compareError).toBeNull();
    await ed.compare('a', 'junk');
    expect(ed.comparison).toBeNull();
    expect(ed.compareError).toMatch(/not an event-tree result/);
    await ed.compare('a', 'b');
    await ed.compare('a', 'gone');
    expect(ed.comparison).toBeNull();
    expect(ed.compareError).toMatch(/Could not read the saved analyses: no saved run called gone/);
    await ed.compare('a', 'b');
    ed.clearComparison();
    expect(ed.comparison).toBeNull();
    expect(ed.compareError).toBeNull();
  });

  it('of two comparisons the later request wins, whichever answers last, and a clear stops a late answer from reappearing', async () => {
    const { ed } = await make({
      loadEventTreeRun: async (id) => {
        if (id === 'slow') await new Promise((r) => setTimeout(r, 30));
        return { id, record: savedRecord(id === 'slow' ? 5 : 2) };
      },
    });
    const first = ed.compare('slow', 'slow2');
    await ed.compare('fast', 'fast2');
    await first;
    expect(ed.comparison?.a).toBe('fast');
    const late = ed.compare('slow', 'slow2');
    ed.clearComparison();
    await late;
    expect(ed.comparison).toBeNull();
  });

  it('the figure of the tree on screen does not show the last good frequency while the entry is not a number', async () => {
    const { ed } = await make();
    expect(ed.figureSvg()).toContain('0.1 per year');
    ed.setFrequencyText('lots');
    expect(ed.figureSvg()).toContain('FREQUENCY NOT SET');
    ed.setFrequencyText('0.3');
    expect(ed.figureSvg()).toContain('0.3 per year');
  });

  // ---- lessons
  const lessonFile = (f: string): EtLesson => parseEtLesson(readFileSync(join(__dirname, '../../lessons/event-trees', f), 'utf8'));
  const SHARED_LESSON = lessonFile('02-shared-event.json');
  const INDEP_LESSON = lessonFile('01-independent-headings.json');
  /** An API whose analysis is the real engine on the real lesson model, so a lesson can be completed end to end. */
  const lessonApi = (extra: Partial<EtApi> = {}): Partial<EtApi> => ({
    eventTreeLessons: async () => [INDEP_LESSON, SHARED_LESSON].map(({ discussion: _d, ...l }) => l),
    runEventTree: async (text): Promise<EtRunResponse> => {
      const doc = JSON.parse(text) as E.EtDoc;
      const lesson = doc.fault_tree_model.name === SHARED_LESSON.model.name ? SHARED_LESSON : INDEP_LESSON;
      const r = computeEventTree(lesson.model.document as unknown as NativeModel, { initiating_event: { frequency: doc.initiating_event.frequency }, headings: doc.headings, end_states: doc.end_states, sequences: doc.sequences });
      const base = recordFor(text, false);
      return { kind: 'ran', run_id: 'r1', record: { ...base, sequences: r.sequences.map((q) => ({ key: q.key, path: q.path, end_state: q.end_state, probability: q.probability, frequency: q.frequency, share: q.probability })) } };
    },
    ...extra,
  });

  it('loads the lessons, and says so when they cannot be loaded', async () => {
    const { ed, api } = await make(lessonApi());
    await ed.loadLessons();
    expect(ed.lessons.map((l) => l.id)).toEqual([INDEP_LESSON.id, SHARED_LESSON.id]);
    expect(ed.lessonsError).toBeNull();
    api.eventTreeLessons = async () => {
      throw new ApiError(503, 'E_LESSONS_UNAVAILABLE', 'refused');
    };
    await ed.loadLessons();
    expect(ed.lessons).toEqual([]);
    expect(ed.lessonsError).toMatch(/Lessons are unavailable: refused/);
  });

  it('starting a lesson saves its model under its own name, replaces the tree, and fills in none of the answer', async () => {
    const { ed, api } = await make(lessonApi());
    await ed.loadLessons();
    expect(await ed.startLesson(SHARED_LESSON.id)).toBe(true);
    expect(api.models.has('lesson-et-shared')).toBe(true);
    expect(JSON.parse(api.models.get('lesson-et-shared')!)).toEqual(SHARED_LESSON.model.document);
    expect(ed.lesson?.id).toBe(SHARED_LESSON.id);
    expect(ed.doc.fault_tree_model.name).toBe('lesson-et-shared');
    expect(ed.doc.fault_tree_model.model_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ed.doc.headings.map((h) => h.event)).toEqual(['S']); // the model's first event: not the answer, not the top
    expect(ed.doc.initiating_event.frequency).toBe(1);
    expect(ed.fileName).toBeNull();
    expect(ed.dirty).toBe(false);
    expect(ed.model?.events.map((e) => e.id)).toEqual(['S', 'a', 'b']);
    await ed.settle();
    expect(ed.validation?.errors.map((e) => e.code)).not.toContain('E_STALE_MODEL');
    expect(ed.lessonProgress!.steps.every((s) => !s.done)).toBe(true);
    expect(ed.lessonProgress!.mistakes).toEqual([]);
  });

  it('an unknown lesson, or a model that cannot be saved, starts nothing and changes nothing', async () => {
    const { ed } = await make(
      lessonApi({
        saveModel: async () => {
          throw new ApiError(500, 'E_X', 'disk full');
        },
      }),
    );
    await ed.loadLessons();
    const before = ed.text;
    expect(await ed.startLesson('nope')).toBe(false);
    expect(await ed.startLesson(SHARED_LESSON.id)).toBe(false);
    expect(ed.lesson).toBeNull();
    expect(ed.text).toBe(before);
    expect(ed.notice?.text).toMatch(/Could not start the lesson: disk full/);
  });

  it('a lesson that was slow to start does not replace a later one', async () => {
    const { ed, api } = await make(lessonApi());
    await ed.loadLessons();
    const realSave = api.saveModel;
    api.saveModel = async (n, t) => {
      if (n === 'lesson-et-shared') await new Promise((r) => setTimeout(r, 30));
      return realSave(n, t);
    };
    const slow = ed.startLesson(SHARED_LESSON.id);
    await ed.startLesson(INDEP_LESSON.id);
    expect(await slow).toBe(false);
    expect(ed.lesson?.id).toBe(INDEP_LESSON.id);
    expect(ed.doc.fault_tree_model.name).toBe('lesson-et-independent');
  });

  it('a student can complete a lesson end to end; the prediction shown is the one typed BEFORE analysing', async () => {
    const { ed } = await make(lessonApi());
    await ed.loadLessons();
    await ed.startLesson(SHARED_LESSON.id);
    ed.setInitiating({ frequency: 0.5 });
    ed.patchHeading('H1', { event: 'X' });
    ed.addHeading();
    ed.patchHeading('H2', { event: 'Y' });
    ed.setUnsetEnds('ES1');
    await ed.settle();
    expect(ed.lessonProgress!.complete).toBe(false);
    expect(ed.prediction).toBeNull();
    ed.setPrediction('0.05');
    expect(ed.prediction).toBe(0.05);
    await ed.run();
    expect(ed.lessonProgress!.complete).toBe(true);
    expect(ed.reveal!.predicted).toBe(0.05);
    expect(ed.reveal!.exact).toBeCloseTo(0.077, 12);
    ed.setPrediction('0.9'); // typed after seeing the answer: not what is shown
    expect(ed.reveal!.predicted).toBe(0.05);
    // a prediction that is not a number counts as none
    ed.setPrediction('lots');
    expect(ed.prediction).toBeNull();
    expect(ed.lessonProgress!.complete).toBe(false);
    ed.setPrediction('-1');
    expect(ed.prediction).toBeNull(); // a frequency is not negative
    ed.setPrediction(' ');
    expect(ed.prediction).toBeNull();
    ed.setPrediction('0');
    expect(ed.prediction).toBe(0);
  });

  it('analysing before a prediction is typed gives no reveal; and the reveal goes when the tree changes', async () => {
    const { ed } = await make(lessonApi());
    await ed.loadLessons();
    await ed.startLesson(SHARED_LESSON.id);
    ed.setInitiating({ frequency: 0.5 });
    ed.patchHeading('H1', { event: 'X' });
    ed.addHeading();
    ed.patchHeading('H2', { event: 'Y' });
    ed.setUnsetEnds('ES1');
    await ed.settle();
    await ed.run();
    expect(ed.reveal).toBeNull();
    ed.setPrediction('0.1');
    await ed.run();
    expect(ed.reveal).not.toBeNull();
    ed.setInitiating({ frequency: 0.6 });
    expect(ed.reveal).toBeNull(); // the result is out of date
    expect(ed.lessonProgress!.complete).toBe(false);
  });

  it('the hand calculation is available only after an analysis, and New, Open and leaving end the lesson', async () => {
    const { ed, api } = await make(lessonApi());
    await ed.loadLessons();
    await ed.startLesson(INDEP_LESSON.id);
    ed.showCalculation();
    expect(ed.calcShown).toBe(false);
    ed.setUnsetEnds('ES1');
    await ed.settle();
    await ed.run();
    expect(ed.hasTried).toBe(true);
    ed.showCalculation();
    expect(ed.calcShown).toBe(true);
    ed.leaveLesson();
    expect(ed.lesson).toBeNull();
    expect(ed.calcShown).toBe(false);
    await ed.startLesson(INDEP_LESSON.id);
    expect(ed.calcShown).toBe(false); // a new start is a fresh lesson
    await ed.newTree();
    expect(ed.lesson).toBeNull();
    await ed.startLesson(INDEP_LESSON.id);
    api.trees.set('t', E.serialize(E.newEventTree(null, 'T', NOW)));
    await ed.open('t');
    expect(ed.lesson).toBeNull();
    ed.setPrediction('5');
    ed.leaveLesson();
    expect(ed.predictionText).toBe('5'); // there is no lesson to leave: nothing to reset
    await ed.startLesson(SHARED_LESSON.id);
    expect(ed.predictionText).toBe('');
  });

  const solved = async (ed: EventTreeEditor): Promise<void> => {
    await ed.loadLessons();
    await ed.startLesson(SHARED_LESSON.id);
    ed.setInitiating({ frequency: 0.5 });
    ed.patchHeading('H1', { event: 'X' });
    ed.addHeading();
    ed.patchHeading('H2', { event: 'Y' });
    ed.setUnsetEnds('ES1');
    await ed.settle();
  };

  it('a model of the student\'s own with the lesson\'s name is never replaced: the lesson takes a numbered name, and a copy of its own model is reused', async () => {
    const { ed, api } = await make(lessonApi());
    const mine = modelText(0.77);
    api.models.set('lesson-et-shared', mine);
    await ed.loadLessons();
    expect(await ed.startLesson(SHARED_LESSON.id)).toBe(true);
    expect(api.models.get('lesson-et-shared')).toBe(mine); // untouched
    expect(ed.doc.fault_tree_model.name).toBe('lesson-et-shared-2');
    expect(JSON.parse(api.models.get('lesson-et-shared-2')!)).toEqual(SHARED_LESSON.model.document);
    expect(ed.notice?.text).toMatch(/already exists and is not this lesson's/);
    // starting again finds its own model under the numbered name and writes nothing more
    let writes = 0;
    const realSave = api.saveModel;
    api.saveModel = async (n, t) => {
      writes++;
      return realSave(n, t);
    };
    await ed.startLesson(SHARED_LESSON.id);
    expect(writes).toBe(0);
    expect(ed.doc.fault_tree_model.name).toBe('lesson-et-shared-2');
    // the same lesson's model under its own name (as saved by an earlier start) is reused, not duplicated
    const { ed: ed2, api: api2 } = await make(lessonApi());
    await ed2.loadLessons();
    await ed2.startLesson(SHARED_LESSON.id);
    await ed2.startLesson(SHARED_LESSON.id);
    expect([...api2.models.keys()].filter((n) => n.startsWith('lesson-et-shared'))).toEqual(['lesson-et-shared']);
  });

  it('when every numbered name is taken by another model, the lesson is not started and nothing is overwritten', async () => {
    const { ed, api } = await make(lessonApi());
    api.models.set('lesson-et-shared', modelText(0.5));
    for (let i = 2; i <= 20; i++) api.models.set(`lesson-et-shared-${i}`, modelText(0.5));
    await ed.loadLessons();
    expect(await ed.startLesson(SHARED_LESSON.id)).toBe(false);
    expect(ed.lesson).toBeNull();
    expect(ed.notice?.text).toMatch(/no free model name/);
    expect(JSON.parse(api.models.get('lesson-et-shared-20')!).events[0].probability).toBe(0.5);
  });

  it('an edit made while a lesson is starting is not thrown away: the start is given up', async () => {
    const { ed, api } = await make(lessonApi());
    await ed.loadLessons();
    const realSave = api.saveModel;
    api.saveModel = async (n, t) => {
      await new Promise((r) => setTimeout(r, 20));
      return realSave(n, t);
    };
    const starting = ed.startLesson(SHARED_LESSON.id);
    ed.setInitiating({ frequency: 7 });
    expect(await starting).toBe(false);
    expect(ed.lesson).toBeNull();
    expect(ed.doc.initiating_event.frequency).toBe(7);
  });

  it('an analysis that comes back after another tree was put on the screen is not shown and does not open the hand calculation', async () => {
    let release: (r: EtRunResponse) => void = () => undefined;
    const { ed, api } = await make(lessonApi());
    await ed.loadLessons();
    await ed.startLesson(INDEP_LESSON.id);
    ed.setUnsetEnds('ES1');
    await ed.settle();
    const realRun = api.runEventTree;
    api.runEventTree = (text, a, id) => {
      const slow = new Promise<EtRunResponse>((res) => (release = res));
      void realRun(text, a, id).then((r) => setTimeout(() => release(r), 15));
      return slow;
    };
    const running = ed.run();
    await new Promise((r) => setTimeout(r, 5));
    await ed.startLesson(SHARED_LESSON.id); // another lesson while the first analysis is under way
    await running;
    expect(ed.result).toBeNull();
    expect(ed.hasTried).toBe(false);
    ed.showCalculation();
    expect(ed.calcShown).toBe(false);
  });

  it('the prediction stays with the analysis it was typed for: a failed rerun or a guess typed later changes nothing beside the earlier result', async () => {
    const { ed, api } = await make(lessonApi());
    await solved(ed);
    ed.setPrediction('0.05');
    await ed.run();
    expect(ed.reveal!.predicted).toBe(0.05);
    ed.setPrediction('0.9');
    const realRun = api.runEventTree;
    api.runEventTree = async () => {
      throw new ApiError(500, 'E_X', 'network');
    };
    await ed.run(); // fails: the earlier result and its prediction stand
    expect(ed.runError).toMatch(/network/);
    expect(ed.reveal!.predicted).toBe(0.05);
    api.runEventTree = realRun;
    await ed.run();
    expect(ed.reveal!.predicted).toBe(0.9); // a real rerun is a new attempt with its own prediction
  });

  it('a prediction typed after the result does not complete the lesson', async () => {
    const { ed } = await make(lessonApi());
    await solved(ed);
    await ed.run(); // no prediction typed
    expect(ed.lessonProgress!.complete).toBe(false);
    ed.setPrediction('0.077'); // the number just read off the table
    expect(ed.lessonProgress!.steps.find((s) => s.id === 'predict')!.done).toBe(true);
    expect(ed.lessonProgress!.complete).toBe(false);
    expect(ed.reveal).toBeNull();
    await ed.run();
    expect(ed.lessonProgress!.complete).toBe(true);
  });

  it('an analysis made with another fault-tree model does not complete the lesson, even with the lesson\'s numbers', async () => {
    const { ed, api } = await make(lessonApi());
    await solved(ed);
    ed.setPrediction('0.1');
    // the student points the tree at a model of their own that happens to have the same events and gates, with one different probability that the headings do not use
    const mine = JSON.parse(JSON.stringify(SHARED_LESSON.model.document));
    mine.model = { ...mine.model, name: 'mine' };
    mine.events.push({ id: 'unused', probability: 0.5 });
    mine.gates[2].inputs = ['X', 'Y'];
    api.models.set('mine', JSON.stringify(mine));
    const lessonRun = api.runEventTree;
    api.runEventTree = async (text, approximation, id) => {
      const doc = JSON.parse(text) as E.EtDoc;
      if (doc.fault_tree_model.name !== 'mine') return lessonRun(text, approximation, id);
      const r = computeEventTree(mine as unknown as NativeModel, { initiating_event: { frequency: doc.initiating_event.frequency }, headings: doc.headings, end_states: doc.end_states, sequences: doc.sequences });
      return { kind: 'ran', run_id: 'r2', record: { ...recordFor(text, false), sequences: r.sequences.map((q) => ({ key: q.key, path: q.path, end_state: q.end_state, probability: q.probability, frequency: q.frequency, share: q.probability })) } };
    };
    await ed.chooseModel('mine');
    await ed.settle();
    await ed.run();
    const p = ed.lessonProgress!;
    expect(p.outcome).toBe('shared'); // same numbers
    expect(p.modelMismatch).toBe(true);
    expect(p.complete).toBe(false);
    await ed.chooseModel('lesson-et-shared');
    await ed.settle();
    await ed.run();
    expect(ed.lessonProgress!.modelMismatch).toBe(false);
    expect(ed.lessonProgress!.complete).toBe(true);
  });
});
