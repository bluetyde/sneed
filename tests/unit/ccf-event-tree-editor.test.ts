import { describe, expect, it } from 'vitest';
import { documentHash, modelHash } from '../../src/core/canonical.js';
import { EVENT_TREE_RESULT_SCHEMA, type EventTreeResult } from '../../src/core/event-tree-result.js';
import { validateModelText } from '../../src/core/validate.js';
import type { EtApi, ValidateResponse } from '../../src/web/api.js';
import * as E from '../../src/web/model/event-tree-doc.js';
import { EventTreeEditor } from '../../src/web/model/event-tree-editor.js';
import { eventTreeResultLines } from '../../src/web/model/event-tree-figure.js';

// Plan 15, after stage C4: the event-tree editor shows which headings depend on a common-cause group of the saved fault-tree model, and says so in the result.

const NOW = '2026-10-25T00:00:00Z';
/** Pumps A and B in a group G (Q = 0.1, beta = 0.1); a gate X over B and D; C and D outside the group. TOP = A AND X. */
const GROUPED = JSON.stringify({
  schema: { id: 'sneed.fault-tree', version: 1 },
  model: { id: 'pumps', name: 'Pumps', created: NOW, updated: NOW },
  assumptions: { probability_model: 'constant', independence: 'beta-factor-groups', coherence: 'coherent', time: 'none' },
  top: 'TOP',
  events: [{ id: 'A', probability: 0.1 }, { id: 'B', probability: 0.1 }, { id: 'C', probability: 0.2 }, { id: 'D', probability: 0.3 }],
  gates: [{ id: 'X', type: 'or', inputs: ['B', 'D'] }, { id: 'Y', type: 'and', inputs: ['X', 'C'] }, { id: 'TOP', type: 'and', inputs: ['A', 'Y'] }],
  common_cause_groups: [{ id: 'G', name: 'Pumps', method: 'beta-factor', members: ['A', 'B'], beta: 0.1 }],
});
const PLAIN = JSON.stringify({ ...JSON.parse(GROUPED), assumptions: { probability_model: 'constant', independence: 'declared-independent', coherence: 'coherent', time: 'none' }, common_cause_groups: undefined });

function editorOn(modelText: string): EventTreeEditor {
  const api = {
    loadModel: async () => modelText,
    validate: async (text: string): Promise<ValidateResponse> => {
      const v = validateModelText(text);
      return { ...v, model_hash: v.valid ? modelHash(JSON.parse(text)) : null, document_hash: documentHash(Buffer.from(text, 'utf8')) } as ValidateResponse;
    },
    listModels: async () => [],
    listEventTrees: async () => [],
    listEventTreeRuns: async () => [],
    validateEventTree: async () => ({ valid: true, errors: [], warnings: [], tree_hash: 'h', document_hash: 'd' }),
    runStatus: async () => ({ running: null, queued: [] }),
  } as unknown as EtApi;
  const ed = new EventTreeEditor(api, { debounceMs: 0, now: () => NOW });
  ed.doc = E.newEventTree({ name: 'pumps', hash: 'x', top: 'A' }, 'Test', NOW);
  return ed;
}
const headings = (ed: EventTreeEditor, events: string[]): void => {
  let d = ed.doc;
  d = { ...d, headings: events.map((event, i) => ({ id: `H${i + 1}`, name: `Heading ${i + 1}`, event })) } as E.EtDoc;
  ed.doc = d;
};

describe('the event-tree editor and common-cause groups', () => {
  it('reads the groups of the saved model, and the gates with their inputs', async () => {
    const ed = editorOn(GROUPED);
    await ed.loadModelInfo();
    expect(ed.model!.groups).toEqual([{ id: 'G', name: 'Pumps', members: ['A', 'B'], beta: 0.1 }]);
    expect(ed.model!.gates.find((g) => g.id === 'X')!.inputs).toEqual(['B', 'D']);
    const plain = editorOn(PLAIN);
    await plain.loadModelInfo();
    expect(plain.model!.groups).toEqual([]);
  });

  it('a heading depends on a group through its event, or through the gates above members', async () => {
    const ed = editorOn(GROUPED);
    await ed.loadModelInfo();
    headings(ed, ['A', 'X', 'C', 'TOP', 'Y', 'nope']);
    const of = (id: string): string[] => ed.headingGroups(id).map((g) => g.id);
    expect(of('H1')).toEqual(['G']); // a member itself
    expect(of('H2')).toEqual(['G']); // a gate over a member (B) and an event outside (D)
    expect(of('H3')).toEqual([]); // an event outside the group
    expect(of('H4')).toEqual(['G']); // the top: it has both members below it
    expect(of('H5')).toEqual(['G']); // a gate with one member below it, found through a nested gate
    expect(of('H6')).toEqual([]); // an event the model does not have
    expect(of('H99')).toEqual([]); // a heading that does not exist
  });

  it('headings on the same group are listed as failing together, with the others left out', async () => {
    const ed = editorOn(GROUPED);
    await ed.loadModelInfo();
    headings(ed, ['A', 'C', 'X']);
    expect(ed.sharedGroups.map((s) => [s.group.id, s.headings])).toEqual([['G', ['H1', 'H3']]]);
    headings(ed, ['A', 'C']);
    expect(ed.sharedGroups).toEqual([]); // one heading on the group is not sharing it
    headings(ed, ['C', 'D']);
    expect(ed.sharedGroups).toEqual([]);
  });

  it('a model without groups, and an editor that has not read its model, show nothing', async () => {
    const plain = editorOn(PLAIN);
    await plain.loadModelInfo();
    headings(plain, ['A', 'X']);
    expect(plain.headingGroups('H1')).toEqual([]);
    expect(plain.sharedGroups).toEqual([]);
    const unread = editorOn(GROUPED);
    headings(unread, ['A', 'X']);
    expect(unread.model).toBeNull();
    expect(unread.headingGroups('H1')).toEqual([]);
    expect(unread.sharedGroups).toEqual([]);
  });

  it('the printed result block names the groups used, and says it is a different kind of result', () => {
    const rec = {
      schema: EVENT_TREE_RESULT_SCHEMA,
      status: 'completed',
      completeness: 'complete',
      reasons: [],
      initiating_event: { name: 'Transient (example)', frequency: 0.5, unit: 'per-year' },
      total: { frequency: 0.5, probability_sum: 1, partition_error: 0 },
      approximation: null,
      engine: { name: 'sneed-bdd', version: '0.1.0' },
      input_hashes: { tree_hash: 'a'.repeat(64), model_hash: 'b'.repeat(64), document_hash: 'c' },
      caveats: ['c1'],
      warnings: [],
      common_cause: { method: 'beta-factor', groups: [{ id: 'G', members: ['A', 'B'], beta: 0.1 }], note: 'n' },
    } as unknown as EventTreeResult;
    const lines = eventTreeResultLines({ record: rec, stale: false });
    expect(lines).toContain('Common-cause groups used (beta-factor): G = A, B, beta 0.1. A different kind of result from one with independent events.');
    const without = eventTreeResultLines({ record: { ...rec, common_cause: undefined } as EventTreeResult, stale: false });
    expect(without.join('\n')).not.toContain('Common-cause');
  });
});
