import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { criterionHash, type ThCriterion } from '../../src/core/th-criterion.js';
import { mutationHash, type ThMutation } from '../../src/core/th-mutation.js';
import { ORACLE_MODELS } from '../oracle/models.js';

// Mutation-record routes and the judgement route (plan 14, stages T0 and T1): a whole chain over HTTP with real saved files.
let tmp: string;
let server: RunningServer;
let projectDir: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-thj-'));
  projectDir = path.join(tmp, 'models');
  const staticDir = path.join(tmp, 'web');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>SNEED</title>');
  server = await startServer({ projectDir, runsDir: path.join(tmp, 'runs'), staticDir, allowedOrigins: ['http://127.0.0.1:5999'], runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 'state') } }, 0);
});
afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Reply {
  status: number;
  json: any;
}
function request(method: string, url: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url, server.url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const JSON_HEADERS = { 'content-type': 'application/json', 'x-sneed-request': '1' };
const post = (url: string, body: unknown): Promise<Reply> => request('POST', url, { body: JSON.stringify(body), headers: JSON_HEADERS });
const put = (url: string, body: unknown): Promise<Reply> => request('PUT', url, { body: JSON.stringify(body), headers: JSON_HEADERS });
const codes = (r: Reply): string[] => r.json.errors.map((e: { code: string }) => e.code);

const H = (c: string): string => c.repeat(64);
const BASE = H('a'); // the plant model 'loop'
const MUTATED = H('e'); // the plant model 'loop-pump-off'
const ENGINE = { name: 'hand', version: '1', build: 'b1' };
const PLANTS = { loop: BASE, 'loop-pump-off': MUTATED };

const record = (): ThMutation => ({
  schema: { id: 'sneed.th-mutation', version: 1 },
  mutation: { id: 'pump1-off', name: 'Pump 1 stopped (example)', description: 'Example.', synthetic: true, created: 't', updated: 't' },
  base_model: { name: 'loop', hash: BASE },
  mutated_model: { name: 'loop-pump-off', hash: MUTATED },
  edits: [{ component: 'pump1', field: 'head.speedRatio', from: 1, to: 0 }],
  applies: 'from-start',
});

let treeHash = '';
let modelHash = '';
const oneHeadingTree = (frequency = 0.5): Record<string, unknown> => ({
  schema: { id: 'sneed.event-tree', version: 1 },
  tree: { id: 'et', name: 'Tree (example)', created: 't', updated: 't' },
  fault_tree_model: { name: 'th-model', model_hash: modelHash },
  initiating_event: { name: 'Transient (example)', description: 'An example.', frequency, unit: 'per-year' },
  headings: [{ id: 'H1', name: 'Forced flow', event: 'AB' }],
  end_states: [
    { id: 'OK', name: 'Fine (example)', description: 'Example.', synthetic: true },
    { id: 'BAD', name: 'Lost (example)', description: 'Example.', synthetic: true },
  ],
  sequences: [
    { path: [{ heading: 'H1', branch: 'works' }], end_state: 'OK' },
    { path: [{ heading: 'H1', branch: 'fails' }], end_state: 'BAD' },
  ],
  assumptions: { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' },
});
// a criterion on the mutated plant, pinning the record
const criterion = (limit: number, over: { model?: [string, string]; list?: string | null } = {}): ThCriterion => ({
  schema: { id: 'sneed.th-criterion', version: 1 },
  criterion: { id: 'flow-kept', name: 'Flow is kept (example)', description: 'Example: pump 1 stopped from the start of the run.', synthetic: true, created: 't', updated: 't' },
  applies_to: { event_tree: { name: 'th-tree', tree_hash: treeHash }, heading: 'H1' },
  plant: { model_name: over.model?.[0] ?? 'loop-pump-off', model_hash: over.model?.[1] ?? MUTATED, mutation_list_hash: over.list === undefined ? mutationHash(record()) : over.list },
  condition: { quantity: 'w_loop', comparison: 'above', limit, unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, holds: 'throughout' },
});
const answerFor = (c: ThCriterion, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: { id: 'sneed.th-answer', version: 1 },
  answer: { id: 'run-1', entered_by: 'hand', entered: 't', note: '' },
  criterion_hash: criterionHash(c),
  plant: { model_hash: c.plant.model_hash, mutation_list_hash: c.plant.mutation_list_hash },
  engine: { ...ENGINE },
  run: { status: 'completed' },
  observed: { quantity: 'w_loop', unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, min: 6.7, max: 30 },
  ...over,
});
const judge = (over: Record<string, unknown> = {}): Promise<Reply> =>
  post('/api/th-judge', { criterion: 'c-ok', answer: 'a-ok', mutation: 'rec', plant_models: PLANTS, engine: ENGINE, ...over });

describe('mutation records and the judgement over the API', () => {
  it('sets up a saved fault-tree model, event tree, mutation record, criteria and answers to refer to', async () => {
    const modelText = JSON.stringify(ORACLE_MODELS['pra-shared']);
    await put('/api/models/th-model', { text: modelText });
    modelHash = (await post('/api/validate', { text: modelText })).json.model_hash;
    const tree = JSON.stringify(oneHeadingTree());
    await put('/api/event-trees/th-tree', { text: tree });
    treeHash = (await post('/api/event-tree/validate', { text: tree })).json.tree_hash;
    expect(treeHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await put('/api/th-mutations/rec', { text: JSON.stringify(record()) })).status).toBe(200);
    const ok = criterion(5); // minimum 6.7 is above 5: held
    const high = criterion(10); // 6.7 is not above 10: did not hold
    await put('/api/th-criteria/c-ok', { text: JSON.stringify(ok) });
    await put('/api/th-criteria/c-high', { text: JSON.stringify(high) });
    await put('/api/th-answers/a-ok', { text: JSON.stringify(answerFor(ok)) });
    await put('/api/th-answers/a-high', { text: JSON.stringify(answerFor(high)) });
  });

  describe('records', () => {
    it('are saved in their own folder, listed apart from the others, and given back as written', async () => {
      const doc = JSON.stringify(record(), null, 2) + '\n';
      expect((await put('/api/th-mutations/exact', { text: doc })).json).toMatchObject({ name: 'exact' });
      expect((await request('GET', '/api/th-mutations/exact')).json.text).toBe(doc);
      expect((await request('GET', '/api/th-mutations')).json.mutations.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['rec', 'exact']));
      expect((await request('GET', '/api/th-criteria')).json.criteria.map((m: { name: string }) => m.name)).not.toContain('exact');
      expect(readdirSync(path.join(projectDir, 'th-mutations'))).toContain('exact.json');
    });

    it('names are checked, text must be JSON, a missing record is 404, writes need the header', async () => {
      for (const name of ['../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(65)]) {
        const r = await put(`/api/th-mutations/${encodeURIComponent(name)}`, { text: '{}' });
        expect(r.status, name).toBe(400);
        expect(r.json.error.code, name).toBe('E_NAME');
      }
      expect((await put('/api/th-mutations/not-json', { text: '{nope' })).json.error.code).toBe('E_NOT_JSON');
      const missing = await request('GET', '/api/th-mutations/nothing-here');
      expect(missing.status).toBe(404);
      expect(missing.json.error.message).toContain('no saved mutation record');
      expect((await request('PUT', '/api/th-mutations/x', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } })).status).toBe(403);
      expect((await request('POST', '/api/th-mutation/validate', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } })).status).toBe(403);
      expect((await post('/api/th-mutation/validate', {})).status).toBe(400);
    });

    it('validate: valid with a hash of what it means; the models are checked only when the caller gives their hashes', async () => {
      const alone = await post('/api/th-mutation/validate', { text: JSON.stringify(record()) });
      expect(alone.json).toMatchObject({ valid: true, errors: [], modelsChecked: false });
      expect(alone.json.mutation_hash).toBe(mutationHash(record()));
      expect(alone.json.document_hash).toMatch(/^[0-9a-f]{64}$/);
      const checked = await post('/api/th-mutation/validate', { text: JSON.stringify(record()), plant_models: PLANTS });
      expect(checked.json).toMatchObject({ valid: true, modelsChecked: true });
      expect(codes(await post('/api/th-mutation/validate', { text: JSON.stringify(record()), plant_models: { ...PLANTS, loop: H('d') } }))).toEqual(['E_STALE_BASE']);
      expect(codes(await post('/api/th-mutation/validate', { text: JSON.stringify(record()), plant_models: { ...PLANTS, 'loop-pump-off': H('d') } }))).toEqual(['E_STALE_MUTATED']);
      expect(codes(await post('/api/th-mutation/validate', { text: JSON.stringify(record()), plant_models: { loop: BASE } }))).toEqual(['E_MODEL_NOT_FOUND']);
    });

    it('validate: problems are named, and bad input is refused in words', async () => {
      const noop = record();
      noop.edits[0]!.to = 1;
      const v = await post('/api/th-mutation/validate', { text: JSON.stringify(noop) });
      expect(codes(v)).toEqual(['E_EDIT_NOOP']);
      expect(v.json.mutation_hash).toBeNull();
      expect((await post('/api/th-mutation/validate', { text: '{nope' })).json).toMatchObject({ valid: false, errors: [{ code: 'E_SCHEMA' }], mutation_hash: null });
      for (const bad of [[], 'x', { a: 'short' }, { a: H('g') }, { '': H('a') }, { ['n'.repeat(201)]: H('a') }]) {
        const r = await post('/api/th-mutation/validate', { text: JSON.stringify(record()), plant_models: bad });
        expect(r.status, JSON.stringify(bad).slice(0, 30)).toBe(400);
        expect(r.json.error.code).toBe('E_FIELD');
      }
      const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, H('a')]));
      expect((await post('/api/th-mutation/validate', { text: JSON.stringify(record()), plant_models: many })).status).toBe(400);
    });
  });

  describe('the judgement', () => {
    it('held and did not hold, with everything it was judged with named; it is a fact about one run and says it is not a probability', async () => {
      const held = await judge();
      expect(held.status).toBe(200);
      expect(held.json).toMatchObject({ status: 'held', reasons: [] });
      expect(held.json.text).toContain('not a probability');
      expect(held.json.judged_with).toEqual({
        criterion: 'c-ok',
        answer: 'a-ok',
        mutation: 'rec',
        event_tree: { name: 'th-tree', hash: treeHash },
        plant_models: { 'loop-pump-off': MUTATED, loop: BASE },
        engine: ENGINE,
      });
      expect(await judge({ criterion: 'c-high', answer: 'a-high' })).toMatchObject({ json: { status: 'did-not-hold', reasons: [] } });
    });

    it('judging writes nothing', async () => {
      const list = (): string[] => ['th-criteria', 'th-answers', 'th-mutations', 'event-trees'].flatMap((d) => readdirSync(path.join(projectDir, d)).map((f) => `${d}/${f}`)).sort();
      const before = list();
      await judge();
      await judge({ criterion: 'c-high', answer: 'a-high' });
      expect(list()).toEqual(before);
    });

    it('stale when the plant model changed since, or the base model of the record, or the engine build', async () => {
      expect((await judge({ plant_models: { ...PLANTS, 'loop-pump-off': H('d') } })).json).toMatchObject({ status: 'stale', reasons: ['plant-changed', 'mutations-changed'] });
      expect((await judge({ plant_models: { ...PLANTS, loop: H('d') } })).json).toMatchObject({ status: 'stale', reasons: ['mutations-changed'] });
      expect((await judge({ engine: { ...ENGINE, build: 'b2' } })).json).toMatchObject({ status: 'stale', reasons: ['engine-changed'] });
      expect((await judge({ engine: { ...ENGINE, version: '2' } })).json.status).toBe('stale');
    });

    it('stale when no mutation record is given although the criterion pins one, or one is given that it does not pin', async () => {
      expect((await judge({ mutation: undefined })).json).toMatchObject({ status: 'stale', reasons: ['mutations-changed'] });
      const edited = record();
      edited.edits[0]!.to = 0.5;
      await put('/api/th-mutations/rec-edited', { text: JSON.stringify(edited) });
      expect((await judge({ mutation: 'rec-edited' })).json).toMatchObject({ status: 'stale', reasons: ['mutations-changed'] });
    });

    it('not determined when the criterion pins the record but runs the unchanged plant (the combined entry refuses what plain judging would read as held)', async () => {
      const wrong = criterion(5, { model: ['loop', BASE] });
      await put('/api/th-criteria/c-wrong-plant', { text: JSON.stringify(wrong) });
      await put('/api/th-answers/a-wrong-plant', { text: JSON.stringify(answerFor(wrong)) });
      const r = await judge({ criterion: 'c-wrong-plant', answer: 'a-wrong-plant' });
      expect(r.json).toMatchObject({ status: 'not-determined', reasons: ['mutation-link-invalid'] });
    });

    it('stale when the saved event tree has changed since, and when it is gone', async () => {
      await put('/api/event-trees/th-tree', { text: JSON.stringify(oneHeadingTree(0.9)) });
      expect((await judge()).json).toMatchObject({ status: 'stale', reasons: ['tree-changed'] });
      await put('/api/event-trees/th-tree', { text: '{"top":"X"}' }); // no longer a valid tree
      expect((await judge()).json).toMatchObject({ status: 'stale', reasons: ['tree-changed'] });
      await put('/api/event-trees/th-tree', { text: JSON.stringify(oneHeadingTree()) }); // restored: current again
      expect((await judge()).json.status).toBe('held');
    });

    it('stale when the criterion was edited after the answer was made', async () => {
      const edited = criterion(4); // another limit: another meaning
      await put('/api/th-criteria/c-edited', { text: JSON.stringify(edited) });
      await put('/api/th-answers/a-for-old', { text: JSON.stringify(answerFor(criterion(5))) });
      expect((await judge({ criterion: 'c-edited', answer: 'a-for-old' })).json).toMatchObject({ status: 'stale', reasons: ['criterion-changed'] });
    });

    it('not determined when the run did not complete, and when a saved document is not valid', async () => {
      const ok = criterion(5);
      await put('/api/th-answers/a-failed', { text: JSON.stringify(answerFor(ok, { run: { status: 'failed' }, observed: null })) });
      expect((await judge({ answer: 'a-failed' })).json).toMatchObject({ status: 'not-determined', reasons: ['run-failed'] });
      await put('/api/th-criteria/c-wip', { text: '{"work":"in progress"}' });
      const wip = await judge({ criterion: 'c-wip', mutation: undefined, plant_models: {} });
      expect(wip.status).toBe(200); // nothing to look up: the criterion is not a criterion
      expect(wip.json).toMatchObject({ status: 'not-determined' });
      expect(wip.json.reasons).toContain('criterion-invalid');
      await put('/api/th-answers/a-wip', { text: '{"work":"in progress"}' });
      expect((await judge({ answer: 'a-wip' })).json.reasons).toEqual(['answer-invalid']);
    });

    it('not determined when the criterion pins the current tree but names a heading the tree does not have', async () => {
      const lost = criterion(5);
      lost.applies_to.heading = 'H9';
      await put('/api/th-criteria/c-lost-heading', { text: JSON.stringify(lost) }); // saved as work in progress: not checked on saving
      await put('/api/th-answers/a-lost-heading', { text: JSON.stringify(answerFor(lost)) });
      expect((await judge({ criterion: 'c-lost-heading', answer: 'a-lost-heading' })).json).toMatchObject({ status: 'not-determined', reasons: ['heading-unknown'] });
    });

    it('needs the base model of the record too, not only the model the criterion runs', async () => {
      const r = await judge({ plant_models: { 'loop-pump-off': MUTATED } });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('E_PLANT_UNKNOWN');
      expect(r.json.error.message).toContain('"loop"');
      expect(r.json.error.message).not.toContain('"loop-pump-off"');
    });

    it('a mutation record that is itself stale (its models differ) makes a criterion that pins it stale', async () => {
      const r = await judge({ plant_models: { ...PLANTS, 'loop-pump-off': MUTATED, loop: H('b') } });
      expect(r.json.status).toBe('stale');
    });

    it('refuses bad requests in words: missing fields, unsaved names, missing or bad plant hashes, bad engine, no header', async () => {
      for (const [over, field] of [[{ criterion: undefined }, 'criterion'], [{ answer: undefined }, 'answer'], [{ criterion: '../x' }, 'criterion'], [{ answer: 5 }, 'answer'], [{ mutation: 'a/b' }, 'mutation']] as const) {
        const r = await judge(over as Record<string, unknown>);
        expect(r.status, field).toBe(400);
        expect(r.json.error.code).toBe('E_FIELD');
        expect(r.json.error.message).toContain(field);
      }
      expect((await judge({ criterion: 'nothing-here' })).json.error.message).toContain('no saved success criterion called nothing-here');
      expect((await judge({ answer: 'nothing-here' })).json.error.message).toContain('no saved answer called nothing-here');
      expect((await judge({ mutation: 'nothing-here' })).json.error.message).toContain('no saved mutation record called nothing-here');
      const unknown = await judge({ plant_models: { loop: BASE } });
      expect(unknown.status).toBe(400);
      expect(unknown.json.error.code).toBe('E_PLANT_UNKNOWN');
      expect(unknown.json.error.message).toContain('"loop-pump-off"');
      expect((await judge({ plant_models: undefined })).json.error.code).toBe('E_FIELD');
      expect((await judge({ plant_models: { ...PLANTS, loop: 'short' } })).json.error.code).toBe('E_FIELD');
      for (const bad of [undefined, 'x', { name: 'hand', version: '1' }, { name: '', version: '1', build: 'b' }, { name: 'a', version: 1, build: 'b' }, { name: 'a', version: 'v', build: 'x'.repeat(201) }]) {
        const r = await judge({ engine: bad });
        expect(r.status, JSON.stringify(bad)).toBe(400);
        expect(r.json.error.code).toBe('E_FIELD');
        expect(r.json.error.message).toContain('engine.');
      }
      expect((await request('POST', '/api/th-judge', { body: JSON.stringify({}), headers: { 'content-type': 'application/json' } })).status).toBe(403);
    });

    it('does not need the plant models of a record it is not given', async () => {
      const plain = criterion(5, { model: ['loop', BASE], list: null });
      await put('/api/th-criteria/c-plain', { text: JSON.stringify(plain) });
      await put('/api/th-answers/a-plain', { text: JSON.stringify(answerFor(plain)) });
      const r = await judge({ criterion: 'c-plain', answer: 'a-plain', mutation: undefined, plant_models: { loop: BASE } });
      expect(r.json).toMatchObject({ status: 'held' });
      expect(r.json.judged_with.mutation).toBeNull();
      expect(r.json.judged_with.plant_models).toEqual({ loop: BASE });
    });
  });

  it('a mutation-record folder that is a link is refused', async () => {
    const outside = path.join(tmp, 'outside-records');
    mkdirSync(outside);
    rmSync(path.join(projectDir, 'th-mutations'), { recursive: true, force: true });
    symlinkSync(outside, path.join(projectDir, 'th-mutations'), 'junction');
    expect((await request('GET', '/api/th-mutations')).json.error.code).toBe('E_LINK');
    expect((await put('/api/th-mutations/x', { text: '{}' })).json.error.code).toBe('E_LINK');
    expect((await judge()).json.error.code).toBe('E_LINK'); // the record cannot be read through it
    expect(readdirSync(outside)).toEqual([]);
  });
});
