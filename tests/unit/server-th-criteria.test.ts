import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { ORACLE_MODELS } from '../oracle/models.js';

// Success criteria for thermal-hydraulic runs over the API (plan 14, stage T0 records): their own folder, checked against the saved event tree.
let tmp: string;
let server: RunningServer;
let projectDir: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-thc-'));
  projectDir = path.join(tmp, 'models');
  const staticDir = path.join(tmp, 'web');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>SNEED</title>');
  server = await startServer(
    {
      projectDir,
      runsDir: path.join(tmp, 'runs'),
      staticDir,
      allowedOrigins: ['http://127.0.0.1:5999'],
      runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 'state') },
    },
    0,
  );
});
afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: string;
  json: any;
}
function request(method: string, url: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url, server.url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(body);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body, json });
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

const ASSUME = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' };
// one heading, H1, on the event AB of pra-shared
const oneHeadingTree = (modelHash: string, frequency = 0.5): Record<string, unknown> => ({
  schema: { id: 'sneed.event-tree', version: 1 },
  tree: { id: 'et', name: 'Tree (example)', created: '2026-10-07T00:00:00Z', updated: '2026-10-07T00:00:00Z' },
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
  assumptions: ASSUME,
});
const criterionFor = (treeName: string, treeHash: string, heading = 'H1'): Record<string, unknown> => ({
  schema: { id: 'sneed.th-criterion', version: 1 },
  criterion: { id: 'flow-kept', name: 'Flow is kept (example)', description: 'Example.', synthetic: true, created: '2026-10-07T00:00:00Z', updated: '2026-10-07T00:00:00Z' },
  applies_to: { event_tree: { name: treeName, tree_hash: treeHash }, heading },
  plant: { model_name: 'loop', model_hash: 'a'.repeat(64), mutation_list_hash: null },
  condition: { quantity: 'w_loop', comparison: 'above', limit: 10, unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, holds: 'throughout' },
});

let treeHash = '';
let modelHash = '';

describe('success criteria over the API', () => {
  it('sets up a saved fault-tree model and a saved event tree to refer to', async () => {
    const modelText = JSON.stringify(ORACLE_MODELS['pra-shared']);
    await put('/api/models/th-model', { text: modelText });
    modelHash = (await post('/api/validate', { text: modelText })).json.model_hash;
    const tree = JSON.stringify(oneHeadingTree(modelHash));
    await put('/api/event-trees/th-tree', { text: tree });
    const v = await post('/api/event-tree/validate', { text: tree });
    expect(v.json.valid).toBe(true);
    treeHash = v.json.tree_hash;
    expect(treeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('saves a criterion in its own folder, lists it apart from models and event trees, and gives back the exact text', async () => {
    const models = (await request('GET', '/api/models')).json.models.length;
    const trees = (await request('GET', '/api/event-trees')).json.trees.length;
    const doc = JSON.stringify(criterionFor('th-tree', treeHash), null, 2) + '\n';
    const saved = await put('/api/th-criteria/flow-1', { text: doc });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ name: 'flow-1' });
    expect((await request('GET', '/api/th-criteria')).json.criteria.map((c: { name: string }) => c.name)).toContain('flow-1');
    expect((await request('GET', '/api/th-criteria/flow-1')).json.text).toBe(doc);
    expect((await request('GET', '/api/models')).json.models).toHaveLength(models);
    expect((await request('GET', '/api/event-trees')).json.trees).toHaveLength(trees);
    expect(readdirSync(path.join(projectDir, 'th-criteria'))).toContain('flow-1.json');
  });

  it('a criterion, an event tree and a model can have the same name without touching each other; unfinished work is saved as it is', async () => {
    await put('/api/th-criteria/th-tree', { text: '{"work":"in progress"}' });
    expect(JSON.parse((await request('GET', '/api/th-criteria/th-tree')).json.text)).toEqual({ work: 'in progress' });
    expect(JSON.parse((await request('GET', '/api/event-trees/th-tree')).json.text).schema.id).toBe('sneed.event-tree');
  });

  it('names are checked like model names, text must be JSON, a missing criterion is 404 in its own words, and writes need the header', async () => {
    for (const name of ['../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(65)]) {
      const r = await put(`/api/th-criteria/${encodeURIComponent(name)}`, { text: '{}' });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code, name).toBe('E_NAME');
    }
    expect((await put('/api/th-criteria/not-json', { text: '{nope' })).json.error.code).toBe('E_NOT_JSON');
    const missing = await request('GET', '/api/th-criteria/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toContain('no saved success criterion');
    const noHeader = await request('PUT', '/api/th-criteria/x', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(403);
    const noHeaderValidate = await request('POST', '/api/th-criterion/validate', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } });
    expect(noHeaderValidate.status).toBe(403);
    expect((await post('/api/th-criterion/validate', {})).status).toBe(400);
  });

  it('validates against the saved event tree: valid, with a hash of its meaning that ignores the title and follows the limit', async () => {
    const r = await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('th-tree', treeHash)) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ valid: true, errors: [], treeChecked: true });
    expect(r.json.criterion_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.document_hash).toMatch(/^[0-9a-f]{64}$/);
    const renamed = criterionFor('th-tree', treeHash) as { criterion: { name: string } };
    renamed.criterion.name = 'Another title';
    expect((await post('/api/th-criterion/validate', { text: JSON.stringify(renamed) })).json.criterion_hash).toBe(r.json.criterion_hash);
    const moved = criterionFor('th-tree', treeHash) as { condition: { limit: number } };
    moved.condition.limit = 11;
    expect((await post('/api/th-criterion/validate', { text: JSON.stringify(moved) })).json.criterion_hash).not.toBe(r.json.criterion_hash);
  });

  it('refuses a heading the tree does not have, a tree that has changed since, and a tree that does not exist', async () => {
    const noHeading = await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('th-tree', treeHash, 'H9')) });
    expect(noHeading.json.valid).toBe(false);
    expect(codes(noHeading)).toEqual(['E_UNKNOWN_HEADING']);
    expect(noHeading.json.criterion_hash).toBeNull();
    expect(codes(await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('th-tree', 'd'.repeat(64))) }))).toEqual(['E_STALE_TREE']);
    expect(codes(await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('no-such-tree', treeHash)) }))).toEqual(['E_NO_TREE']);
  });

  it('a saved tree with another meaning gives another hash: a criterion written for the first tree is stale against the second', async () => {
    await put('/api/event-trees/th-tree-b', { text: JSON.stringify(oneHeadingTree(modelHash, 0.9)) });
    expect(codes(await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('th-tree-b', treeHash)) }))).toEqual(['E_STALE_TREE']);
  });

  it('a saved tree that is not a valid tree, and a name that is not a name, are "no such tree"', async () => {
    await put('/api/event-trees/broken-tree', { text: '{"top":"X"}' });
    // a tree that parses, has headings and could be hashed, but whose sequences do not add up to the whole, is not a tree to refer to
    const incomplete = oneHeadingTree(modelHash) as { sequences: unknown[] };
    incomplete.sequences.pop();
    await put('/api/event-trees/incomplete-tree', { text: JSON.stringify(incomplete) });
    expect(codes(await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('incomplete-tree', treeHash)) }))).toEqual(['E_NO_TREE']);
    expect(codes(await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('broken-tree', treeHash)) }))).toEqual(['E_NO_TREE']);
    expect(codes(await post('/api/th-criterion/validate', { text: JSON.stringify(criterionFor('../secret', treeHash)) }))).toEqual(['E_NO_TREE']);
  });

  it('text that is not a document is reported as E_SCHEMA, not as a server error; another kind of document is refused', async () => {
    const bad = await post('/api/th-criterion/validate', { text: '{nope' });
    expect(bad.status).toBe(200);
    expect(bad.json).toMatchObject({ valid: false, errors: [{ code: 'E_SCHEMA' }], criterion_hash: null });
    const wrongKind = await post('/api/th-criterion/validate', { text: JSON.stringify(oneHeadingTree('a'.repeat(64))) });
    expect(wrongKind.json.valid).toBe(false);
    expect(wrongKind.json.criterion_hash).toBeNull();
  });
});
