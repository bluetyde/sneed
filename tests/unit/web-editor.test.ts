import { describe, expect, it } from 'vitest';
import { documentHash, modelHash } from '../../src/core/canonical.js';
import { validateModelText } from '../../src/core/validate.js';
import type { ResultRecord } from '../../src/core/result.js';
import { ApiError, type Api, type Method, type ModelInfo, type RunResponse, type ValidateResponse } from '../../src/web/api.js';
import { Editor } from '../../src/web/model/editor.js';
import * as D from '../../src/web/model/doc.js';

/** An API that validates for real (same core as the server) and lets each test script the rest. */
function fakeApi(over: Partial<Api> = {}): Api & { calls: string[]; files: Map<string, string> } {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const api: Api = {
    health: async () => ({ name: 'sneed', runtime: { installed: true, install_id: 'i1', recipe_revision: 1, engine_version: '0.16.2' } }),
    validate: async (text): Promise<ValidateResponse> => {
      calls.push('validate');
      const v = validateModelText(text);
      let model_hash: string | null = null;
      try {
        model_hash = modelHash(JSON.parse(text));
      } catch {
        model_hash = null;
      }
      return { ...v, model_hash, document_hash: documentHash(Buffer.from(text, 'utf8')) } as ValidateResponse;
    },
    run: async (text, method): Promise<RunResponse> => {
      calls.push(`run:${method}`);
      return { kind: 'ran', run_id: 'r1', record: recordFor(text, method) };
    },
    cancel: async () => ({ cancelled: true }),
    listModels: async (): Promise<ModelInfo[]> => [...files.keys()].map((name) => ({ name, bytes: files.get(name)!.length, modified: '2026-10-05T00:00:00Z' })),
    loadModel: async (name) => {
      if (!files.has(name)) throw new ApiError(404, 'E_NOT_FOUND', `no saved model called ${name}`);
      return files.get(name)!;
    },
    saveModel: async (name, text) => {
      files.set(name, text);
      return { name, bytes: text.length, modified: '2026-10-05T00:00:00Z' };
    },
    ...over,
  };
  return Object.assign(api, { calls, files });
}

function recordFor(text: string, method: Method): ResultRecord {
  return {
    schema_version: 1,
    status: 'completed',
    completeness: 'complete',
    reasons: [],
    quantity: 'top_event_probability',
    unit: 'dimensionless',
    method,
    assumptions: {},
    engine: { name: 'SCRAM', version: '0.16.2', sha256: 'x', runtime: null },
    warnings: [],
    settings: { method, limitOrder: 2 },
    input_hashes: { model_hash: modelHash(JSON.parse(text)), document_hash: documentHash(Buffer.from(text)), exported_input_hash: 'e' },
    exporter_version: 'x',
    parser_version: 'x',
    top_event_probability: 0.19,
    approximation_value: null,
    caveats: [],
    minimal_cut_sets: [
      { events: ['E1'], probability: 0.1 },
      { events: ['E2'], probability: 0.1 },
    ],
  } as ResultRecord;
}

async function ready(api = fakeApi()): Promise<{ ed: Editor; api: ReturnType<typeof fakeApi> }> {
  const ed = new Editor(api, { debounceMs: 0, now: () => '2026-10-05T12:00:00Z' });
  await ed.loadHealth();
  await ed.settle();
  return { ed, api };
}

describe('starting state', () => {
  it('opens on a valid two-event OR, not dirty, with nothing selected', async () => {
    const { ed } = await ready();
    expect(ed.validation?.valid).toBe(true);
    expect(ed.dirty).toBe(false);
    expect(ed.selected).toBeNull();
    expect(ed.canUndo).toBe(false);
    expect(ed.canRun).toBe(true);
    expect(ed.runBlockedReason).toBeNull();
  });
});

describe('history', () => {
  it('every edit is one undoable step with a label, and redo replays it', async () => {
    const { ed } = await ready();
    ed.select('E1');
    ed.setProbability('E1', 0.5);
    expect(ed.undoLabel).toBe('Set probability of E1');
    expect(ed.dirty).toBe(true);
    expect(D.findEvent(ed.doc, 'E1')!.probability).toBe(0.5);
    expect(ed.undo()).toBe('Set probability of E1');
    expect(D.findEvent(ed.doc, 'E1')!.probability).toBe(0.1);
    expect(ed.dirty).toBe(false); // back to the saved text
    expect(ed.canRedo).toBe(true);
    expect(ed.redo()).toBe('Set probability of E1');
    expect(D.findEvent(ed.doc, 'E1')!.probability).toBe(0.5);
    expect(ed.undo()).not.toBeNull();
    expect(ed.undo()).toBeNull();
  });

  it('undo and redo tell subscribers and re-check the model, so the screen and the problems follow', async () => {
    const { ed } = await ready();
    ed.setProbability('E1', 2); // invalid
    await ed.settle();
    expect(ed.validation!.valid).toBe(false);
    let notified = 0;
    ed.subscribe(() => notified++);
    ed.undo();
    expect(notified).toBeGreaterThan(0);
    await ed.settle();
    expect(ed.validation!.valid).toBe(true); // the undo was validated, not just applied
    const before = notified;
    ed.redo();
    expect(notified).toBeGreaterThan(before);
    await ed.settle();
    expect(ed.validation!.valid).toBe(false);
  });

  it('undo clears an explained cut set, because the drawing it pointed at has changed', async () => {
    const { ed } = await ready();
    await ed.run();
    ed.setProbability('E1', 0.3);
    ed.explainCutSet(0);
    expect(ed.highlight).not.toEqual([]);
    ed.undo();
    expect(ed.highlight).toEqual([]);
  });

  it('a new edit clears the redo stack', async () => {
    const { ed } = await ready();
    ed.setProbability('E1', 0.2);
    ed.undo();
    ed.setProbability('E2', 0.3);
    expect(ed.canRedo).toBe(false);
  });

  it('an edit that changes nothing is not a step', async () => {
    const { ed } = await ready();
    ed.setProbability('E1', 0.1);
    ed.setName('E1', '');
    expect(ed.canUndo).toBe(false);
    expect(ed.dirty).toBe(false);
  });

  it('layout moves are steps too, and undo restores the earlier position', async () => {
    const { ed } = await ready();
    ed.moveNode('E1', 10.4, 20.6);
    expect(ed.doc.layout!.nodes).toEqual([{ id: 'E1', x: 10, y: 21 }]); // whole pixels
    expect(ed.undoLabel).toBe('Move node');
    ed.undo();
    expect(ed.doc.layout).toBeUndefined();
  });

  it('undo drops a selection whose node no longer exists', async () => {
    const { ed } = await ready();
    const id = ed.addEvent();
    expect(ed.selected).toBe(id);
    ed.undo();
    expect(ed.selected).toBeNull();
  });

  it('non-finite numbers are refused before they reach the document', async () => {
    const { ed } = await ready();
    expect(ed.setProbability('E1', Number.NaN)).toBe(false);
    expect(ed.setThreshold('G1', Number.POSITIVE_INFINITY)).toBe(false);
    expect(ed.canUndo).toBe(false);
  });
});

describe('selection and adding', () => {
  it('a new node attaches to the selected gate; with a basic event selected it stays unattached', async () => {
    const { ed } = await ready();
    ed.select('G1');
    const e = ed.addEvent();
    expect(D.findGate(ed.doc, 'G1')!.inputs).toContain(e);
    ed.select('E1');
    const loose = ed.addEvent();
    expect(ed.doc.gates.some((g) => g.inputs.includes(loose))).toBe(false);
    expect(ed.selected).toBe(loose);
  });

  it('adding a gate selects it and labels the step', async () => {
    const { ed } = await ready();
    ed.select('G1');
    const g = ed.addGate('atleast');
    expect(ed.selected).toBe(g);
    expect(ed.undoLabel).toBe(`Add K-of-N gate ${g}`);
  });

  it('selecting an unknown key clears the selection', async () => {
    const { ed } = await ready();
    ed.select('E1');
    ed.select('NOPE');
    expect(ed.selected).toBeNull();
  });
});

describe('deleting', () => {
  it('deleting a node removes it everywhere and clears the selection', async () => {
    const { ed } = await ready();
    ed.select('E1');
    ed.deleteSelected();
    expect(D.findGate(ed.doc, 'G1')!.inputs).toEqual(['E2']);
    expect(ed.selected).toBeNull();
  });

  it('deleting a repeated reference removes only that input and keeps the node it pointed at', async () => {
    const { ed } = await ready();
    ed.connect('G1', 'E1'); // E1 twice: G1#2 is a reference
    expect(ed.visual.byKey.get('G1#2')!.kind).toBe('reference');
    ed.select('G1#2');
    ed.deleteSelected();
    expect(D.findGate(ed.doc, 'G1')!.inputs).toEqual(['E1', 'E2']);
    expect(D.findEvent(ed.doc, 'E1')).toBeDefined();
    expect(ed.selected).toBe('G1'); // focus goes to the gate that lost the input
  });

  it('deleting a missing-reference marker removes the dangling input', async () => {
    const { ed } = await ready();
    ed.connect('G1', 'GHOST');
    await ed.settle();
    expect(ed.problems.map((p) => p.code)).toContain('E_MISSING_REF');
    ed.select('G1#2');
    ed.deleteSelected();
    await ed.settle();
    expect(ed.validation!.valid).toBe(true);
  });

  it('delete with nothing selected does nothing', async () => {
    const { ed } = await ready();
    ed.deleteSelected();
    expect(ed.canUndo).toBe(false);
  });
});

describe('problems', () => {
  it('shows the validator problems live and selecting one lands on the offender', async () => {
    const { ed } = await ready();
    ed.select('G1');
    ed.addGate('and');
    ed.connect('G2', 'G1'); // G1 -> G2 -> G1
    await ed.settle();
    const cycle = ed.problems.find((p) => p.code === 'E_CYCLE')!;
    expect(cycle).toBeDefined();
    expect(ed.errorCount).toBe(1);
    ed.select(null);
    ed.selectIssue(cycle);
    expect(['G1', 'G2']).toContain(ed.selected);
  });

  it('a late validation answer for older text never replaces a newer one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const api = fakeApi();
    const real = api.validate;
    api.validate = async (text) => {
      if (first) {
        first = false;
        await gate; // the very first answer arrives late
      }
      return real(text);
    };
    const ed = new Editor(api, { debounceMs: 0 });
    const slow = ed.revalidate(); // text A, answer withheld
    ed.setProbability('E1', 1.5); // text B: invalid
    const fast = ed.revalidate();
    await fast;
    expect(ed.validation!.valid).toBe(false);
    release();
    await slow;
    expect(ed.validation!.valid).toBe(false); // still the answer for text B
  });

  it('a server failure while checking becomes a visible notice, not a silent pass', async () => {
    const api = fakeApi({
      validate: async () => {
        throw new Error('server went away');
      },
    });
    const ed = new Editor(api, { debounceMs: 0 });
    await ed.settle();
    expect(ed.validation).toBeNull();
    expect(ed.notice).toMatchObject({ kind: 'error' });
    expect(ed.notice!.text).toContain('server went away');
    expect(ed.runBlockedReason).toContain('not been checked');
  });
});

describe('running', () => {
  it('runs the exact text that was checked and stores the result', async () => {
    const { ed, api } = await ready();
    await ed.run();
    expect(api.calls.filter((c) => c.startsWith('run'))).toEqual(['run:exact']);
    expect(ed.result).toMatchObject({ kind: 'ran' });
    expect(ed.running).toBe(false);
    expect(ed.stale).toBe(false);
  });

  it('is blocked by problems, with the count in words, and does not call the engine', async () => {
    const { ed, api } = await ready();
    ed.setProbability('E1', 2);
    await ed.settle();
    expect(ed.canRun).toBe(false);
    expect(ed.runBlockedReason).toBe('1 problem to fix first');
    await ed.run();
    expect(api.calls.some((c) => c.startsWith('run'))).toBe(false);
    expect(ed.notice).toMatchObject({ kind: 'warning' });
    expect(ed.notice!.text).toContain('1 problem to fix first');
  });

  it('is blocked when no runtime is installed and says how to fix it', async () => {
    const api = fakeApi({ health: async () => ({ name: 'sneed', runtime: { installed: false, code: 'E_SETUP_REQUIRED', message: 'x' } }) });
    const { ed } = await ready(api);
    expect(ed.canRun).toBe(false);
    expect(ed.runBlockedReason).toContain('npm run runtime -- install');
  });

  it('a server refusal is kept as the result and shown, with no record', async () => {
    const api = fakeApi({ run: async () => ({ kind: 'refused', errors: [{ code: 'E_EXPORT_LIMIT', severity: 'error', path: '/', message: 'too big' }], warnings: [] }) });
    const { ed } = await ready(api);
    await ed.run();
    expect(ed.result).toMatchObject({ kind: 'refused', errors: [{ code: 'E_EXPORT_LIMIT' }] });
    expect(ed.stale).toBe(false);
  });

  it('a setup error marks the runtime missing and shows the message', async () => {
    const api = fakeApi({
      run: async () => {
        throw new ApiError(503, 'E_SETUP_REQUIRED', 'no active SCRAM runtime');
      },
    });
    const { ed } = await ready(api);
    await ed.run();
    expect(ed.runError).toContain('no active SCRAM runtime');
    expect(ed.runtime?.installed).toBe(false);
    expect(ed.running).toBe(false);
  });

  it('only one run at a time, and cancel is passed through only while running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = fakeApi({
      run: async (text, method) => {
        await gate;
        return { kind: 'ran', run_id: 'r1', record: recordFor(text, method) };
      },
    });
    let cancels = 0;
    api.cancel = async () => {
      cancels++;
      return { cancelled: true };
    };
    const { ed } = await ready(api);
    await ed.cancel();
    expect(cancels).toBe(0);
    const p = ed.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(ed.running).toBe(true);
    expect(ed.canRun).toBe(false);
    await ed.run(); // ignored
    await ed.cancel();
    expect(cancels).toBe(1);
    release();
    await p;
    expect(ed.running).toBe(false);
  });
});

describe('what makes a result stale', () => {
  it('a probability edit makes it stale; undoing it makes it current again', async () => {
    const { ed } = await ready();
    await ed.run();
    ed.setProbability('E1', 0.3);
    await ed.settle();
    expect(ed.stale).toBe(true);
    ed.undo();
    await ed.settle();
    expect(ed.stale).toBe(false);
  });

  it('a layout move or a rename leaves the result current: the model hash did not change', async () => {
    const { ed } = await ready();
    await ed.run();
    ed.moveNode('E1', 5, 5);
    ed.setName('E2', 'Pump 2');
    ed.setNote('E1', 'a note');
    await ed.settle();
    expect(ed.dirty).toBe(true);
    expect(ed.stale).toBe(false);
  });

  it('changing the method makes it stale; changing it back does not', async () => {
    const { ed } = await ready();
    await ed.run();
    ed.setMethod('mcub');
    expect(ed.stale).toBe(true);
    ed.setMethod('exact');
    expect(ed.stale).toBe(false);
  });

  it('a gate wired to itself changes the model hash, so the earlier result is stale', async () => {
    const { ed } = await ready();
    await ed.run();
    ed.connect('G1', 'G1'); // cycle through itself
    await ed.settle();
    expect(ed.validation!.model_hash).not.toBeNull(); // still hashable
    expect(ed.stale).toBe(true);
  });
});

describe('explaining a result', () => {
  it('selecting a cut set highlights its events; any edit clears it', async () => {
    const { ed } = await ready();
    await ed.run();
    ed.explainCutSet(1);
    expect(ed.highlight).toEqual(['E2']);
    ed.setProbability('E1', 0.2);
    expect(ed.highlight).toEqual([]);
    ed.explainCutSet(0);
    ed.clearExplain();
    expect(ed.highlight).toEqual([]);
    ed.explainCutSet(99);
    expect(ed.highlight).toEqual([]);
  });

  it('describes a cut set in plain language, with names where there are any', async () => {
    const { ed } = await ready();
    ed.setName('E1', 'Pump 1');
    expect(ed.describeCutSet(['E1'])).toBe('The top event occurs if Pump 1 fails.');
    expect(ed.describeCutSet(['E1', 'E2'])).toBe('The top event occurs if Pump 1 and E2 both fail.');
    expect(ed.describeCutSet(['A', 'B', 'C'])).toBe('The top event occurs if A, B, and C all fail.');
  });
});

describe('files', () => {
  it('a new model is clean and unnamed; a first save needs a name', async () => {
    const { ed } = await ready();
    ed.setProbability('E1', 0.4);
    ed.newModel();
    expect(ed.dirty).toBe(false);
    expect(ed.fileName).toBeNull();
    expect(ed.canUndo).toBe(false);
    expect(ed.result).toBeNull();
    expect(await ed.save()).toBe(false);
  });

  it('save stores the text, stamps the update time as a non-undoable change, and clears dirty', async () => {
    const { ed, api } = await ready();
    ed.setProbability('E1', 0.4);
    expect(ed.dirty).toBe(true);
    expect(await ed.save('lesson-1')).toBe(true);
    expect(ed.dirty).toBe(false);
    expect(ed.fileName).toBe('lesson-1');
    expect(ed.doc.model.updated).toBe('2026-10-05T12:00:00Z');
    expect(JSON.parse(api.files.get('lesson-1')!).events[0].probability).toBe(0.4);
    expect(ed.undoLabel).toBe('Set probability of E1'); // the stamp is not a step
    expect(ed.models.map((m) => m.name)).toEqual(['lesson-1']);
    expect(await ed.save()).toBe(true); // second save needs no name
  });

  it('saving and reloading gives the same model hash; saving changes only the document hash', async () => {
    const { ed } = await ready();
    ed.setProbability('E1', 0.4);
    await ed.settle();
    const before = ed.validation!.model_hash;
    const docBefore = ed.validation!.document_hash;
    await ed.save('same');
    await ed.settle();
    expect(ed.validation!.model_hash).toBe(before);
    expect(ed.validation!.document_hash).not.toBe(docBefore); // updated timestamp
    await ed.open('same');
    await ed.settle();
    expect(ed.validation!.model_hash).toBe(before);
  });

  it('opening a file formatted differently is not unsaved work, and clears history and results', async () => {
    const api = fakeApi();
    api.files.set('four-space', JSON.stringify(D.newModel('x', '2026-10-05T00:00:00Z'), null, 4));
    const { ed } = await ready(api);
    await ed.run();
    ed.setProbability('E1', 0.9);
    expect(await ed.open('four-space')).toBe(true);
    expect(ed.dirty).toBe(false);
    expect(ed.canUndo).toBe(false);
    expect(ed.result).toBeNull();
    expect(ed.fileName).toBe('four-space');
  });

  it('a file that cannot be drawn, or does not exist, is refused with a message and nothing changes', async () => {
    const api = fakeApi();
    api.files.set('broken', JSON.stringify({ ...D.newModel(), events: 'no' }));
    const { ed } = await ready(api);
    ed.setProbability('E1', 0.7);
    expect(await ed.open('broken')).toBe(false);
    expect(ed.notice!.text).toContain('cannot be drawn');
    expect(await ed.open('missing')).toBe(false);
    expect(ed.notice!.text).toContain('no saved model called missing');
    expect(D.findEvent(ed.doc, 'E1')!.probability).toBe(0.7); // the open work is untouched
  });

  it('a failed save keeps the work dirty and says why', async () => {
    const api = fakeApi({
      saveModel: async () => {
        throw new ApiError(400, 'E_NAME', 'bad name');
      },
    });
    const { ed } = await ready(api);
    ed.setProbability('E1', 0.7);
    expect(await ed.save('x')).toBe(false);
    expect(ed.dirty).toBe(true);
    expect(ed.notice).toMatchObject({ kind: 'error' });
  });

  it('subscribers are told about changes and can unsubscribe', async () => {
    const { ed } = await ready();
    let n = 0;
    const off = ed.subscribe(() => n++);
    ed.setProbability('E1', 0.2);
    expect(n).toBeGreaterThan(0);
    off();
    const seen = n;
    ed.setProbability('E1', 0.3);
    expect(n).toBe(seen);
  });
});
