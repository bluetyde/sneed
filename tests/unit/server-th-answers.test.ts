import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { criterionHash, type ThCriterion } from '../../src/core/th-criterion.js';

// Answer records over the API (plan 14, stage T0 records): their own folder, validated alone, and matched by hash to the saved criterion they pin.
let tmp: string;
let server: RunningServer;
let projectDir: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-tha-'));
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

const criterion = (limit = 10): ThCriterion => ({
  schema: { id: 'sneed.th-criterion', version: 1 },
  criterion: { id: 'flow-kept', name: 'Flow is kept (example)', description: 'Example.', synthetic: true, created: 't', updated: 't' },
  applies_to: { event_tree: { name: 'tree-a', tree_hash: 'c'.repeat(64) }, heading: 'H1' },
  plant: { model_name: 'loop', model_hash: 'a'.repeat(64), mutation_list_hash: null },
  condition: { quantity: 'w_loop', comparison: 'above', limit, unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, holds: 'throughout' },
});
const answerFor = (c: ThCriterion): Record<string, unknown> => ({
  schema: { id: 'sneed.th-answer', version: 1 },
  answer: { id: 'run-1', entered_by: 'hand', entered: '2026-10-08T00:00:00Z', note: '' },
  criterion_hash: criterionHash(c),
  plant: { model_hash: 'a'.repeat(64), mutation_list_hash: null },
  engine: { name: 'hand', version: '1', build: 'b1' },
  run: { status: 'completed' },
  observed: { quantity: 'w_loop', unit: 'kg/s', window: { from: 0, to: 8, unit: 's' }, min: 6.7, max: 30 },
});

describe('answer records over the API', () => {
  it('saves an answer in its own folder, lists it apart from the other folders, and gives back the exact text', async () => {
    const models = (await request('GET', '/api/models')).json.models.length;
    const doc = JSON.stringify(answerFor(criterion()), null, 2) + '\n';
    const saved = await put('/api/th-answers/run-1', { text: doc });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ name: 'run-1' });
    expect((await request('GET', '/api/th-answers')).json.answers.map((a: { name: string }) => a.name)).toContain('run-1');
    expect((await request('GET', '/api/th-answers/run-1')).json.text).toBe(doc);
    expect((await request('GET', '/api/models')).json.models).toHaveLength(models);
    expect((await request('GET', '/api/th-criteria')).json.criteria.map((a: { name: string }) => a.name)).not.toContain('run-1');
    expect(readdirSync(path.join(projectDir, 'th-answers'))).toContain('run-1.json');
  });

  it('names are checked like model names, text must be JSON, a missing answer is 404 in its own words, and writes need the header', async () => {
    for (const name of ['../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(65)]) {
      const r = await put(`/api/th-answers/${encodeURIComponent(name)}`, { text: '{}' });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code, name).toBe('E_NAME');
    }
    expect((await put('/api/th-answers/not-json', { text: '{nope' })).json.error.code).toBe('E_NOT_JSON');
    const missing = await request('GET', '/api/th-answers/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toContain('no saved answer');
    expect((await request('PUT', '/api/th-answers/x', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect((await request('POST', '/api/th-answer/validate', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect((await post('/api/th-answer/validate', {})).status).toBe(400);
  });

  it('validates the record alone and names the problem', async () => {
    const ok = await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(criterion())) });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ valid: true, errors: [] });
    expect(ok.json.document_hash).toMatch(/^[0-9a-f]{64}$/);
    const noObs = answerFor(criterion()) as { observed: unknown };
    noObs.observed = null;
    expect(codes(await post('/api/th-answer/validate', { text: JSON.stringify(noObs) }))).toEqual(['E_NO_OBSERVED']);
    const backwards = answerFor(criterion()) as { observed: { min: number; max: number } };
    backwards.observed.min = 99;
    expect(codes(await post('/api/th-answer/validate', { text: JSON.stringify(backwards) }))).toEqual(['E_OBSERVED_ORDER']);
    const bad = await post('/api/th-answer/validate', { text: '{nope' });
    expect(bad.status).toBe(200);
    expect(bad.json).toMatchObject({ valid: false, errors: [{ code: 'E_SCHEMA' }], criterion: null });
    expect((await post('/api/th-answer/validate', { text: JSON.stringify(criterion()) })).json.valid).toBe(false); // another kind of document
  });

  it('names the saved criterion the answer pins, by the hash of what it means', async () => {
    await put('/api/th-criteria/flow-a', { text: JSON.stringify(criterion(10)) });
    await put('/api/th-criteria/flow-b', { text: JSON.stringify(criterion(20)) });
    const r = await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(criterion(20))) });
    expect(r.json).toMatchObject({ valid: true, criterion: { name: 'flow-b' }, criteria_search_complete: true });
    expect(r.json.criteria_searched).toBeGreaterThanOrEqual(1);
    // a renamed copy means the same: still found
    const renamed = criterion(10);
    renamed.criterion.name = 'Another title';
    expect((await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(renamed)) })).json.criterion).toEqual({ name: 'flow-a' });
  });

  it('finds no criterion when the one it pinned has since been edited, or never existed: the answer is for a criterion that is not saved', async () => {
    const edited = (await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(criterion(11))) })).json;
    expect(edited).toMatchObject({ valid: true, criterion: null, criteria_search_complete: true });
    const invalidHash = answerFor(criterion()) as { criterion_hash: string };
    invalidHash.criterion_hash = 'f'.repeat(64);
    expect((await post('/api/th-answer/validate', { text: JSON.stringify(invalidHash) })).json.criterion).toBeNull();
  });

  it('skips a saved criterion that is not valid, even when its meaning hashes to what the answer pins', async () => {
    const c = criterion(33);
    // not valid (the example label is text), yet the label is not part of what the criterion means: the hash would match
    const broken = JSON.parse(JSON.stringify(c)) as { criterion: { synthetic: unknown } };
    broken.criterion.synthetic = 'yes';
    expect(criterionHash(broken as unknown as ThCriterion)).toBe(criterionHash(c));
    await put('/api/th-criteria/broken', { text: JSON.stringify(broken) });
    await put('/api/th-criteria/not-a-criterion', { text: '{"work":"in progress"}' });
    expect((await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(c)) })).json.criterion).toBeNull();
  });

  it('with two saved criteria of the same meaning, names the newest', async () => {
    const dir = path.join(projectDir, 'th-criteria');
    const c = criterion(55);
    const twin = JSON.parse(JSON.stringify(c)) as ThCriterion;
    twin.criterion.name = 'Twin with another title';
    writeFileSync(path.join(dir, 'twin-old.json'), JSON.stringify(c));
    writeFileSync(path.join(dir, 'twin-new.json'), JSON.stringify(twin));
    utimesSync(path.join(dir, 'twin-old.json'), new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
    utimesSync(path.join(dir, 'twin-new.json'), new Date(Date.now() + 7200_000), new Date(Date.now() + 7200_000));
    expect((await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(c)) })).json.criterion).toEqual({ name: 'twin-new' });
  });

  it('searches only the newest 200 criteria: exactly 200 are all searched, one more is not, and it says so', async () => {
    const dir = path.join(projectDir, 'th-criteria');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const oldest = criterion(777);
    writeFileSync(path.join(dir, 'oldest.json'), JSON.stringify(oldest));
    const past = new Date(Date.now() - 3600_000);
    utimesSync(path.join(dir, 'oldest.json'), past, past);
    for (let i = 0; i < 199; i++) writeFileSync(path.join(dir, `filler-${i}.json`), '{"work":"in progress"}');
    const exactly = await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(oldest)) });
    expect(exactly.json.criterion).toEqual({ name: 'oldest' }); // the 200th is still searched
    expect(exactly.json.criteria_search_complete).toBe(true);
    expect(exactly.json.criteria_searched).toBe(200);
    writeFileSync(path.join(dir, 'filler-extra.json'), '{"work":"in progress"}');
    const over = await post('/api/th-answer/validate', { text: JSON.stringify(answerFor(oldest)) });
    expect(over.json.criterion).toBeNull(); // now the oldest is beyond the newest 200
    expect(over.json.criteria_search_complete).toBe(false);
    expect(over.json.criteria_searched).toBe(200);
  });

  it('refuses an answer folder that is a link', async () => {
    const outside = path.join(tmp, 'outside-answers');
    mkdirSync(outside);
    rmSync(path.join(projectDir, 'th-answers'), { recursive: true, force: true });
    symlinkSync(outside, path.join(projectDir, 'th-answers'), 'junction');
    const l = await request('GET', '/api/th-answers');
    expect(l.status).toBe(400);
    expect(l.json.error.code).toBe('E_LINK');
    const p = await put('/api/th-answers/x', { text: '{}' });
    expect(p.json.error.code).toBe('E_LINK');
    expect(readdirSync(outside)).toEqual([]);
  });
});
