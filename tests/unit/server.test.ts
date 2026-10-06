import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnalyzeOptions, AnalyzeOutcome } from '../../src/core/analyze.js';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { readRun } from '../../src/server/runs.js';
import { MAX_MODEL_BYTES, isValidModelName, listModels, readModel, writeImport, writeModel, StorageError } from '../../src/server/storage.js';
import { RuntimeNotInstalledError } from '../../src/runtime/resolve.js';
import { AND, mkDoc, OR, ORACLE_MODELS } from '../oracle/models.js';
import { skeletonSequences } from '../../src/core/event-tree.js';
import { BDD_ENGINE_NAME, BDD_ENGINE_VERSION } from '../../src/engines/bdd/solve.js';
import { BDD_SOURCE_SHA256 } from '../../src/engines/bdd/build-id.js';

let tmp: string;
let server: RunningServer;
let projectDir: string;
let staticDir: string;
let analyzeCalls: { text: string; opts: AnalyzeOptions }[] = [];
let analyzeImpl: (text: string, opts: AnalyzeOptions) => Promise<AnalyzeOutcome>;

const fakeRecord = { status: 'completed', completeness: 'complete', top_event_probability: 0.02 };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-server-'));
  projectDir = path.join(tmp, 'models');
  staticDir = path.join(tmp, 'web');
  mkdirSync(staticDir, { recursive: true });
  mkdirSync(path.join(staticDir, 'assets'));
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>SNEED</title>');
  writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');
  analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
  server = await startServer(
    {
      projectDir,
      runsDir: path.join(tmp, 'runs'),
      staticDir,
      allowedOrigins: ['http://127.0.0.1:5999'],
      runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 'state') },
      analyzeFn: async (text, opts) => {
        analyzeCalls.push({ text, opts });
        return analyzeImpl(text, opts);
      },
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
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}
function request(method: string, url: string, opts: { body?: string | Buffer; headers?: Record<string, string>; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url, server.url);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.host) headers.host = opts.host;
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const JSON_HEADERS = { 'content-type': 'application/json', 'x-sneed-request': '1' };
const post = (url: string, body: unknown, headers: Record<string, string> = JSON_HEADERS): Promise<Reply> => request('POST', url, { body: JSON.stringify(body), headers });
const text = (id: string): string => JSON.stringify(ORACLE_MODELS[id]);

describe('storage', () => {
  it('model names are plain file stems', () => {
    for (const ok of ['a', 'pump-lesson_1', 'My.model.v2', 'x'.repeat(64)]) expect(isValidModelName(ok), ok).toBe(true);
    for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 'name.', 'a..b', '-lead', 'C:evil', 'nul\0']) expect(isValidModelName(bad), JSON.stringify(bad)).toBe(false);
  });

  it('writes atomically, lists newest first, reads back the exact text and never writes outside the folder', () => {
    const dir = path.join(tmp, 'store1');
    expect(listModels(dir)).toEqual([]); // a missing folder is empty, not an error
    const a = writeModel(dir, 'first', '{"a":1}');
    expect(a).toMatchObject({ name: 'first', bytes: 7 });
    writeModel(dir, 'second', '{"b":2}\n');
    expect(readModel(dir, 'second')).toBe('{"b":2}\n');
    expect(listModels(dir).map((m) => m.name).sort()).toEqual(['first', 'second']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    for (const bad of ['../escape', 'a/b', '/abs']) {
      expect(() => writeModel(dir, bad, '{}'), bad).toThrow(StorageError);
      expect(() => readModel(dir, bad), bad).toThrow(StorageError);
    }
    expect(() => readModel(dir, 'missing')).toThrow(/no saved model/);
  });

  it('refuses text that is not JSON and text that is too large, and leaves the old file alone', () => {
    const dir = path.join(tmp, 'store2');
    writeModel(dir, 'keep', '{"v":1}');
    expect(() => writeModel(dir, 'keep', '{not json')).toThrow(/not valid JSON/);
    expect(() => writeModel(dir, 'keep', JSON.stringify({ pad: 'x'.repeat(MAX_MODEL_BYTES) }))).toThrow(/larger than/);
    expect(readModel(dir, 'keep')).toBe('{"v":1}');
  });

  it('listing ignores other files and unsafe names', () => {
    const dir = path.join(tmp, 'store3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'good.json'), '{}');
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    writeFileSync(path.join(dir, '.hidden.json'), '{}');
    writeFileSync(path.join(dir, 'with space.json'), '{}');
    mkdirSync(path.join(dir, 'folder.json'));
    expect(listModels(dir).map((m) => m.name)).toEqual(['good']);
  });
});

describe('request safety', () => {
  it('refuses a Host header that is not this server (DNS rebinding)', async () => {
    const r = await request('GET', '/api/health', { host: 'evil.example:80' });
    expect(r.status).toBe(421);
    expect(r.json.error.code).toBe('E_HOST');
    expect((await request('GET', '/api/health', { host: `127.0.0.1:${server.port + 1}` })).status).toBe(421);
  });

  it('accepts localhost and the loopback address', async () => {
    expect((await request('GET', '/api/health', { host: `localhost:${server.port}` })).status).toBe(200);
    expect((await request('GET', '/api/health')).status).toBe(200);
  });

  it('refuses a foreign Origin and allows the configured dev origin and its own', async () => {
    expect((await request('GET', '/api/health', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await request('GET', '/api/health', { headers: { origin: 'http://127.0.0.1:5999' } })).status).toBe(200);
    expect((await request('GET', '/api/health', { headers: { origin: server.url } })).status).toBe(200);
  });

  it('writes need the custom header and a JSON content type', async () => {
    const noHeader = await request('POST', '/api/validate', { body: '{"text":"{}"}', headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.json.error.code).toBe('E_CSRF');
    const form = await request('POST', '/api/validate', { body: 'text=x', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-sneed-request': '1' } });
    expect(form.status).toBe(415);
    const plain = await request('PUT', '/api/models/x', { body: '{"text":"{}"}', headers: { 'content-type': 'text/plain', 'x-sneed-request': '1' } });
    expect(plain.status).toBe(415);
  });

  it('refuses malformed, non-object and oversized bodies without crashing', async () => {
    expect((await request('POST', '/api/validate', { body: '{oops', headers: JSON_HEADERS })).json.error.code).toBe('E_BAD_JSON');
    expect((await request('POST', '/api/validate', { body: '[1,2]', headers: JSON_HEADERS })).json.error.code).toBe('E_BAD_JSON');
    expect((await post('/api/validate', { text: 5 })).json.error.code).toBe('E_FIELD');
    const big = await request('POST', '/api/validate', { body: Buffer.alloc(MAX_MODEL_BYTES + 200000, 'a'), headers: JSON_HEADERS });
    expect(big.status).toBe(413);
    expect((await request('GET', '/api/health')).status).toBe(200); // still serving
  });

  it('unknown API routes and methods are 404, and errors never carry a stack or a path', async () => {
    const r = await request('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body).not.toMatch(/at .*\.ts|node_modules|C:\\/);
  });
});

describe('health and validation', () => {
  it('reports that no runtime is installed, with the typed code', async () => {
    const r = await request('GET', '/api/health');
    expect(r.json).toMatchObject({ name: 'sneed', runtime: { installed: false, code: 'E_SETUP_REQUIRED' } });
    expect(r.json.runtime.message).toContain('npm run runtime -- install');
  });

  it('validates text and returns the hashes: a valid model has both, layout leaves the model hash alone', async () => {
    const doc = ORACLE_MODELS['pra-pump3-shared'];
    const a = (await post('/api/validate', { text: JSON.stringify(doc) })).json;
    expect(a).toMatchObject({ valid: true, errors: [] });
    expect(a.model_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.document_hash).toMatch(/^[0-9a-f]{64}$/);
    const b = (await post('/api/validate', { text: JSON.stringify({ ...doc, layout: { nodes: [{ id: 'TOP', x: 3, y: 4 }] } }) })).json;
    expect(b.model_hash).toBe(a.model_hash);
    expect(b.document_hash).not.toBe(a.document_hash);
    const c = (await post('/api/validate', { text: JSON.stringify({ ...doc, events: doc!.events.map((e, i) => (i === 0 ? { ...e, probability: 0.5 } : e)) }) })).json;
    expect(c.model_hash).not.toBe(a.model_hash);
  });

  it('returns every problem with its code and ids, and no model hash when the ids clash', async () => {
    const doc = { ...ORACLE_MODELS['pra-and'], events: [...ORACLE_MODELS['pra-and']!.events, { id: 'A', probability: 0.2 }] };
    const r = (await post('/api/validate', { text: JSON.stringify(doc) })).json;
    expect(r.valid).toBe(false);
    expect(r.errors.map((e: { code: string }) => e.code)).toEqual(['E_DUP_ID']);
    expect(r.errors[0].ids).toEqual(['A']);
    expect(r.model_hash).toBeNull();
    expect((await post('/api/validate', { text: '{nope' })).json).toMatchObject({ valid: false, model_hash: null });
  });
});

describe('model files over the API', () => {
  it('saves, lists and loads a model, byte for byte', async () => {
    const body = text('pra-and') + '\n';
    const put = await request('PUT', '/api/models/two-events', { body: JSON.stringify({ text: body }), headers: JSON_HEADERS });
    expect(put.status).toBe(200);
    expect(put.json.name).toBe('two-events');
    expect(readFileSync(path.join(projectDir, 'two-events.json'), 'utf8')).toBe(body);
    expect((await request('GET', '/api/models')).json.models.map((m: { name: string }) => m.name)).toContain('two-events');
    expect((await request('GET', '/api/models/two-events')).json).toEqual({ name: 'two-events', text: body });
  });

  it('refuses unsafe names and missing models with typed errors', async () => {
    for (const name of ['..%2Fescape', '%2Fabs', 'a%2Fb', '.hidden']) {
      const r = await request('PUT', `/api/models/${name}`, { body: JSON.stringify({ text: '{}' }), headers: JSON_HEADERS });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code, name).toBe('E_NAME');
    }
    expect((await request('GET', '/api/models/nothing-here')).status).toBe(404);
    expect((await request('PUT', '/api/models/bad', { body: JSON.stringify({ text: '{broken' }), headers: JSON_HEADERS })).json.error.code).toBe('E_NOT_JSON');
    expect(readdirSync(tmp).includes('escape.json')).toBe(false);
  });
});

describe('runs', () => {
  it('passes the model and method to the engine and returns the record with a run id (never a path)', async () => {
    analyzeCalls = [];
    const r = await post('/api/run', { text: text('pra-and'), method: 'mcub', engine: 'scram' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'ran', run_id: 'run-1', record: fakeRecord });
    expect(r.body).not.toContain(tmp);
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0]!.opts.settings).toEqual({ method: 'mcub' });
    expect(analyzeCalls[0]!.text).toBe(text('pra-and'));
  });

  it('defaults to the exact method and refuses an unknown one', async () => {
    analyzeCalls = [];
    await post('/api/run', { text: text('pra-and'), engine: 'scram' });
    expect(analyzeCalls[0]!.opts.settings).toEqual({ method: 'exact' });
    const bad = await post('/api/run', { text: text('pra-and'), method: 'magic', engine: 'scram' });
    expect(bad.status).toBe(400);
    expect(analyzeCalls).toHaveLength(1);
  });

  it('returns a refusal with the typed errors and no run', async () => {
    analyzeImpl = async () => ({ kind: 'refused', errors: [{ code: 'E_CYCLE', path: '/gates/0', message: 'gate cycle', ids: ['A', 'B'] }], warnings: [] });
    const r = await post('/api/run', { text: text('pra-and'), engine: 'scram' });
    expect(r.json).toMatchObject({ kind: 'refused', errors: [{ code: 'E_CYCLE', ids: ['A', 'B'] }] });
  });

  it('a missing runtime is a 503 with the setup code', async () => {
    analyzeImpl = async () => {
      throw new RuntimeNotInstalledError('x');
    };
    const r = await post('/api/run', { text: text('pra-and'), engine: 'scram' });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('E_SETUP_REQUIRED');
  });

  it('an unexpected failure is a plain 500 without details', async () => {
    analyzeImpl = async () => {
      throw new Error('secret path C:\\Users\\x failed');
    };
    const r = await post('/api/run', { text: text('pra-and'), engine: 'scram' });
    expect(r.status).toBe(500);
    expect(r.body).not.toContain('secret');
  });

  it('one run at a time: a second request waits, and cancel aborts the first', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    analyzeImpl = (_t, opts) =>
      new Promise((resolve) => {
        signal ??= opts.signal; // the first run's signal
        started();
        opts.signal?.addEventListener('abort', () => resolve({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-cancelled'), record: { status: 'cancelled' } as never }), { once: true });
      });
    const callsBefore = analyzeCalls.length;
    const first = post('/api/run', { text: text('pra-and'), engine: 'scram' });
    await hasStarted;
    const second = post('/api/run', { text: text('pra-and'), engine: 'scram' }); // waits its turn instead of being refused
    await new Promise((r) => setTimeout(r, 100));
    expect(analyzeCalls.length).toBe(callsBefore + 1); // only the first has reached the engine
    expect(signal!.aborted).toBe(false);
    expect((await post('/api/run/cancel', {})).json).toEqual({ cancelled: true });
    const done = await first;
    expect(done.json.record.status).toBe('cancelled');
    expect(signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(analyzeCalls.length).toBe(callsBefore + 2); // the waiting run started when the first was done
    expect((await post('/api/run/cancel', {})).json).toEqual({ cancelled: true }); // and cancel now reaches that one
    expect((await second).json.record.status).toBe('cancelled');
    expect((await post('/api/run/cancel', {})).json).toEqual({ cancelled: false }); // nothing running now
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
    expect((await post('/api/run', { text: text('pra-and'), engine: 'scram' })).status).toBe(200); // free again
  });

  it('a browser that disconnects mid-run aborts the engine', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    analyzeImpl = (_t, opts) =>
      new Promise((resolve) => {
        signal = opts.signal;
        started();
        opts.signal?.addEventListener('abort', () => resolve({ kind: 'ran', runDir: path.join(tmp, 'runs', 'gone'), record: {} as never }), { once: true });
      });
    const u = new URL('/api/run', server.url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: JSON_HEADERS });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ text: text('pra-and'), engine: 'scram' }));
    await hasStarted;
    req.destroy();
    for (let i = 0; i < 50 && !signal!.aborted; i++) await new Promise((r) => setTimeout(r, 20));
    expect(signal!.aborted).toBe(true);
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
  });
});

describe('static files', () => {
  it('serves the app, assets and the single-page fallback with a strict content security policy', async () => {
    const root = await request('GET', '/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('<title>SNEED</title>');
    expect(root.headers['content-security-policy']).toContain("default-src 'self'");
    expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(root.headers['x-content-type-options']).toBe('nosniff');
    const js = await request('GET', '/assets/app.js');
    expect(js.headers['content-type']).toContain('text/javascript');
    expect((await request('GET', '/some/route')).body).toContain('<title>SNEED</title>');
  });

  it('never serves a file outside the web folder', async () => {
    for (const p of ['/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2F..%2Fsecret.txt', '/..%5Csecret.txt', '/%00']) {
      const r = await request('GET', p);
      expect(r.body, p).not.toContain('top secret');
    }
    expect((await request('GET', '/missing.js')).status).toBe(404);
  });

  it('refuses writes to static routes', async () => {
    expect((await request('POST', '/', { headers: JSON_HEADERS })).status).toBe(405);
  });
});

describe('lessons over the API', () => {
  const lessonsDir = path.join(import.meta.dirname, '../../lessons');
  const oraclesFile = path.join(import.meta.dirname, '../oracles.json');
  const withServer = async (extra: Record<string, string>, fn: (url: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-lessons-'));
    const s = await startServer({ projectDir: path.join(dir, 'm'), runsDir: path.join(dir, 'r'), runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(dir, 's') }, ...extra }, 0);
    try {
      await fn(s.url);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const get = async (url: string): Promise<{ status: number; json: any }> => {
    const res = await fetch(url + '/api/lessons');
    return { status: res.status, json: await res.json() };
  };

  it('serves the four validated lessons', async () => {
    await withServer({ lessonsDir, oraclesFile }, async (url) => {
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.json.lessons.map((l: { id: string }) => l.id)).toEqual(['01-single-pump', '02-redundant-pumps', '03-shared-power-supply', '04-voting']);
    });
  });

  it('answers 503 when lessons are not configured', async () => {
    await withServer({}, async (url) => expect((await get(url)).json.error).toEqual({ code: 'E_LESSONS_UNAVAILABLE', message: 'lessons are not configured' }));
  });

  it('answers 503 when the oracle file is missing, and serves nothing', async () => {
    await withServer({ lessonsDir, oraclesFile: path.join(tmp, 'no-such.json') }, async (url) => {
      const r = await get(url);
      expect(r.status).toBe(503);
      expect(r.json.lessons).toBeUndefined();
    });
  });

  it('refuses every lesson if one file is invalid, naming the file and not a path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-badlesson-'));
    try {
      writeFileSync(path.join(dir, '01-bad.json'), readFileSync(path.join(lessonsDir, '01-single-pump.json'), 'utf8').replace('"probability": 0.1', '"probability": 0.2'));
      await withServer({ lessonsDir: dir, oraclesFile }, async (url) => {
        const r = await get(url);
        expect(r.status).toBe(503);
        expect(r.json.error.message).toMatch(/01-bad\.json.*L_ORACLE_MISMATCH/);
        expect(r.json.error.message).not.toContain(dir);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('saved runs over the API', () => {
  const makeRun = (runs: string, id: string, rec: Record<string, unknown>, model: string | null = '{"model":{"name":"Pumps"},"events":[],"gates":[],"top":""}'): void => {
    mkdirSync(path.join(runs, id, 'native'), { recursive: true });
    writeFileSync(path.join(runs, id, 'results.json'), JSON.stringify(rec));
    if (model !== null) writeFileSync(path.join(runs, id, 'native', 'model.json'), model);
  };
  const rec = (p: number): Record<string, unknown> => ({ schema_version: 1, status: 'completed', completeness: 'complete', method: 'exact', top_event_probability: p, input_hashes: { model_hash: 'h' } });
  const withRuns = async (setup: (runs: string) => void, fn: (url: string, runs: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-runs-'));
    const runs = path.join(dir, 'runs');
    setup(runs);
    const s = await startServer({ projectDir: path.join(dir, 'm'), runsDir: runs, runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(dir, 's') } }, 0);
    try {
      await fn(s.url, runs);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const get = async (url: string): Promise<{ status: number; json: any }> => {
    const res = await fetch(url);
    return { status: res.status, json: await res.json() };
  };

  it('lists runs newest first with a summary, and skips folders that are not readable runs', async () => {
    await withRuns(
      (runs) => {
        makeRun(runs, '2026-10-05T10-00-00-000Z-aaaa', rec(0.01));
        makeRun(runs, '2026-10-05T11-00-00-000Z-bbbb', rec(0.19));
        makeRun(runs, '2026-10-05T12-00-00-000Z-broken', { schema_version: 2 });
        mkdirSync(path.join(runs, '2026-10-05T13-00-00-000Z-empty'), { recursive: true });
        writeFileSync(path.join(runs, 'stray-file.txt'), 'x');
        makeRun(runs, '2026-10-05T09-00-00-000Z-nomodel', rec(0.5), null);
      },
      async (url) => {
        const r = await get(url + '/api/runs');
        expect(r.status).toBe(200);
        expect(r.json.runs.map((x: { id: string }) => x.id)).toEqual(['2026-10-05T11-00-00-000Z-bbbb', '2026-10-05T10-00-00-000Z-aaaa', '2026-10-05T09-00-00-000Z-nomodel']);
        expect(r.json.runs[0]).toMatchObject({ status: 'completed', method: 'exact', top_event_probability: 0.19, model_name: 'Pumps', model_hash: 'h' });
        expect(r.json.runs[2].model_name).toBeNull();
      },
    );
  });

  it('a missing runs folder is an empty list', async () => {
    await withRuns(() => undefined, async (url) => expect((await get(url + '/api/runs')).json.runs).toEqual([]));
  });

  it('returns one run: the model text as saved and the record', async () => {
    await withRuns(
      (runs) => makeRun(runs, 'run-1', rec(0.19), '{"events":[],"gates":[]}'),
      async (url) => {
        const r = await get(url + '/api/runs/run-1');
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ id: 'run-1', model_text: '{"events":[],"gates":[]}', record: rec(0.19) });
      },
    );
  });

  it('refuses path tricks and unknown ids, and never reads outside the runs folder', async () => {
    await withRuns(
      (runs) => {
        makeRun(runs, 'run-1', rec(0.1));
        writeFileSync(path.join(path.dirname(runs), 'results.json'), JSON.stringify({ secret: true }));
      },
      async (url) => {
        for (const id of ['..', '%2e%2e', 'a%2f..%2f..', '..%2F', '.hidden', 'run-1%5C..', 'x'.repeat(200), '%']) {
          const r = await get(`${url}/api/runs/${id}`);
          expect([400, 404], id).toContain(r.status);
          expect(JSON.stringify(r.json)).not.toContain('secret');
        }
        expect((await get(url + '/api/runs/no-such-run')).status).toBe(404);
        expect((await get(url + '/api/runs/no-such-run')).json.error.code).toBe('E_NOT_FOUND');
      },
    );
  });

  it('a run whose files are damaged answers 422 without leaking a path', async () => {
    await withRuns(
      (runs) => {
        mkdirSync(path.join(runs, 'bad', 'native'), { recursive: true });
        writeFileSync(path.join(runs, 'bad', 'results.json'), '{ not json');
      },
      async (url, runs) => {
        const r = await get(url + '/api/runs/bad');
        expect(r.status).toBe(422);
        expect(r.json.error.code).toBe('E_UNREADABLE');
        expect(JSON.stringify(r.json)).not.toContain(runs);
      },
    );
  });

  it('the runs routes are read-only', async () => {
    await withRuns(
      (runs) => makeRun(runs, 'run-1', rec(0.1)),
      async (url, runs) => {
        for (const m of ['PUT', 'DELETE', 'POST']) {
          const res = await fetch(url + '/api/runs/run-1', { method: m, headers: { 'x-sneed-request': '1', 'content-type': 'application/json' }, body: m === 'DELETE' ? undefined : '{}' });
          expect(res.status, m).toBeGreaterThanOrEqual(400);
        }
        expect(readdirSync(runs)).toEqual(['run-1']);
        expect(readFileSync(path.join(runs, 'run-1', 'results.json'), 'utf8')).toBe(JSON.stringify(rec(0.1)));
      },
    );
  });

  it('a run reached through a link is neither listed nor served, and nothing outside the runs folder is read (Codex review)', async () => {
    await withRuns(
      (runs) => {
        const outside = path.join(path.dirname(runs), 'outside');
        mkdirSync(path.join(outside, 'native'), { recursive: true });
        writeFileSync(path.join(outside, 'results.json'), JSON.stringify({ ...rec(0.5), secret: 'OUTSIDE' }));
        writeFileSync(path.join(outside, 'native', 'model.json'), '{"secret":"OUTSIDE"}');
        mkdirSync(runs, { recursive: true });
        symlinkSync(outside, path.join(runs, 'linked-run'), 'junction');
        makeRun(runs, 'real-run', rec(0.1));
      },
      async (url) => {
        const list = await get(url + '/api/runs');
        expect(list.json.runs.map((x: { id: string }) => x.id)).toEqual(['real-run']);
        const one = await get(url + '/api/runs/linked-run');
        expect(one.status).toBe(422);
        expect(JSON.stringify(one.json)).not.toContain('OUTSIDE');
      },
    );
  });

  it('a link to another run inside the runs folder is not followed either (a copy would be served under the wrong id)', async () => {
    await withRuns(
      (runs) => {
        makeRun(runs, 'real-run', rec(0.1));
        symlinkSync(path.join(runs, 'real-run'), path.join(runs, 'alias-run'), 'junction');
      },
      async (url) => {
        expect((await get(url + '/api/runs')).json.runs.map((x: { id: string }) => x.id)).toEqual(['real-run']);
        expect((await get(url + '/api/runs/alias-run')).status).toBe(422);
      },
    );
  });


  it('a folder swapped for a link between the check and the read is refused and the outside file is not served (Codex review)', async () => {
    await withRuns(
      (runs) => {
        makeRun(runs, 'run-1', rec(0.1));
        const outside = path.join(path.dirname(runs), 'outside-swap');
        mkdirSync(outside, { recursive: true });
        writeFileSync(path.join(outside, 'model.json'), '{"secret":"OUTSIDE"}');
      },
      async (_url, runs) => {
        const outside = path.join(path.dirname(runs), 'outside-swap');
        const swap = (): void => {
          rmSync(path.join(runs, 'run-1', 'native'), { recursive: true, force: true });
          symlinkSync(outside, path.join(runs, 'run-1', 'native'), 'junction');
        };
        expect(() => readRun(runs, 'run-1', swap)).toThrow();
        try {
          const r = readRun(runs, 'run-1');
          expect(JSON.stringify(r)).not.toContain('OUTSIDE');
        } catch {
          /* refused: also fine */
        }
      },
    );
  });

  it('a model file replaced by another file while it is being read is not served', async () => {
    await withRuns(
      (runs) => makeRun(runs, 'run-1', rec(0.1), '{"which":"original"}'),
      async (_url, runs) => {
        const file = path.join(runs, 'run-1', 'native', 'model.json');
        const replace = (): void => {
          rmSync(file);
          writeFileSync(file, '{"which":"replacement"}');
        };
        expect(() => readRun(runs, 'run-1', undefined, replace)).toThrow();
        expect(readRun(runs, 'run-1').model_text).toBe('{"which":"replacement"}'); // a fresh, undisturbed read is fine
      },
    );
  });

  it('a model file that is a link to a file elsewhere is not served', async () => {
    await withRuns(
      (runs) => {
        makeRun(runs, 'run-1', rec(0.1));
        const target = path.join(path.dirname(runs), 'secret.txt');
        writeFileSync(target, '{"secret":"OUTSIDE"}');
        rmSync(path.join(runs, 'run-1', 'native', 'model.json'));
        try {
          symlinkSync(target, path.join(runs, 'run-1', 'native', 'model.json'), 'file');
        } catch {
          writeFileSync(path.join(runs, 'run-1', 'native', 'model.json'), '{}'); // no privilege to make a file symlink here; the junction test covers links
        }
      },
      async (url) => {
        const r = await get(url + '/api/runs/run-1');
        expect(JSON.stringify(r.json)).not.toContain('OUTSIDE');
      },
    );
  });

  it('a model file that is not JSON is not served', async () => {
    await withRuns(
      (runs) => makeRun(runs, 'run-1', rec(0.1), 'not json at all'),
      async (url) => {
        const r = await get(url + '/api/runs/run-1');
        expect(r.status).toBe(422);
        expect(r.json.error.code).toBe('E_UNREADABLE');
      },
    );
  });
});

describe('engine choice over the API (plan 10)', () => {
  const doc = (): string => text('pra-or');
  const post2 = (body: unknown): Promise<Reply> => post('/api/run', body);

  it('the built-in engine is the default: no SCRAM call is made, and it works with no runtime installed', async () => {
    const before = analyzeCalls.length;
    const r = await post2({ text: doc() });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('ran');
    expect(r.json.record).toMatchObject({ status: 'completed', completeness: 'complete', engine: { name: 'sneed-bdd', runtime: null } });
    expect(r.json.record.top_event_probability).toBeCloseTo(0.28, 12);
    expect(analyzeCalls.length).toBe(before); // the stand-in SCRAM was not asked
    expect(r.json.cross).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain(tmp); // never a path
  });

  it('health lists both engines', async () => {
    const r = await request('GET', '/api/health');
    expect(r.json.engines.builtin).toMatchObject({ available: true, name: 'sneed-bdd' });
    expect(r.json.engines.scram).toMatchObject({ installed: false });
    expect(r.json.runtime).toEqual(r.json.engines.scram); // the old field is kept
  });

  it('an unknown engine is refused', async () => {
    const r = await post2({ text: doc(), engine: 'quantum' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('E_FIELD');
  });

  it('"both" without a SCRAM runtime still answers with the built-in result and says there is no second opinion', async () => {
    const r = await post2({ text: doc(), engine: 'both' });
    expect(r.status).toBe(200);
    expect(r.json.record.engine.name).toBe('sneed-bdd');
    expect(r.json.cross).toMatchObject({ unavailable: true });
    expect(typeof r.json.cross.reason).toBe('string');
  });

  it('a refused model is refused by the built-in engine with the validator codes', async () => {
    const bad = JSON.parse(text('pra-and'));
    bad.events[0].probability = 7;
    const r = await post2({ text: JSON.stringify(bad) });
    expect(r.json.kind).toBe('refused');
    expect(r.json.errors.some((e: { code: string }) => e.code === 'E_PROB_RANGE')).toBe(true);
  });
});

describe('import over the API (Open-PSA)', () => {
  const GOOD = ['<?xml version="1.0"?>', '<opsa-mef>', '  <define-fault-tree name="Pumps">', '    <define-gate name="TOP"><or><basic-event name="A"/><basic-event name="B"/></or></define-gate>', '    <define-basic-event name="A"><float value="0.1"/></define-basic-event>', '    <define-basic-event name="B"><float value="0.2"/></define-basic-event>', '  </define-fault-tree>', '</opsa-mef>', ''].join('\n');
  const files = (): string[] => readdirSync(projectDir).filter((f) => f.startsWith('imp-')).sort();

  it('imports a file: the model, the original byte for byte and the notes are saved beside each other', async () => {
    const r = await post('/api/import', { text: GOOD, name: 'imp-good' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'imported', name: 'imp-good', summary: { top: 'TOP', events: 2, gates: 1 } });
    expect(files()).toEqual(['imp-good.json', 'imp-good.opsa-import.log', 'imp-good.opsa.xml']);
    expect(readFileSync(path.join(projectDir, 'imp-good.opsa.xml'), 'utf8')).toBe(GOOD);
    const model = JSON.parse(readFileSync(path.join(projectDir, 'imp-good.json'), 'utf8'));
    expect(model).toMatchObject({ top: 'TOP', model: { name: 'Pumps' } });
    expect(JSON.parse(readFileSync(path.join(projectDir, 'imp-good.opsa-import.log'), 'utf8'))).toMatchObject({ importer: 'sneed-import-1', source_sha256: r.json.source_sha256 });
    const listed = await request('GET', '/api/models');
    expect(listed.json.models.map((m: { name: string }) => m.name)).toContain('imp-good');
    expect(listed.json.models.map((m: { name: string }) => m.name)).not.toContain('imp-good.opsa-import'); // the notes are not a model
    const again = await request('GET', '/api/models/imp-good');
    expect(JSON.parse(again.json.text).events).toHaveLength(2);
  });

  it('a refusal lists every problem with its line, and writes nothing', async () => {
    const bad = GOOD.replace('<float value="0.2"/>', '<float value="7"/>').replace('<define-gate name="TOP">', '<define-house-event name="H"/><define-gate name="TOP">');
    const r = await post('/api/import', { text: bad, name: 'imp-bad' });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('refused');
    expect(r.json.errors.map((e: { code: string }) => e.code).sort()).toEqual(['E_PROB_RANGE', 'E_UNSUPPORTED']);
    expect(r.json.errors.every((e: { line: number }) => e.line > 0)).toBe(true);
    expect(files().filter((f) => f.startsWith('imp-bad'))).toEqual([]);
  });

  it('an existing model is never replaced, and a failed import leaves no stray file', async () => {
    const before = readFileSync(path.join(projectDir, 'imp-good.json'), 'utf8');
    const r = await post('/api/import', { text: GOOD.replace('Pumps', 'Other'), name: 'imp-good' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('E_EXISTS');
    expect(readFileSync(path.join(projectDir, 'imp-good.json'), 'utf8')).toBe(before);
    expect(readFileSync(path.join(projectDir, 'imp-good.opsa.xml'), 'utf8')).toBe(GOOD);
    // a leftover note file of that name stops the import before the model is written, and the original written first is removed
    writeFileSync(path.join(projectDir, 'imp-late.opsa-import.log'), 'theirs');
    const late = await post('/api/import', { text: GOOD, name: 'imp-late' });
    expect(late.status).toBe(409);
    expect(files().filter((f) => f.startsWith('imp-late'))).toEqual(['imp-late.opsa-import.log']);
    expect(readFileSync(path.join(projectDir, 'imp-late.opsa-import.log'), 'utf8')).toBe('theirs');
  });

  it('names are checked like model names: no path, no odd characters', async () => {
    for (const name of ['../escape', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(65), 'a b']) {
      const r = await post('/api/import', { text: GOOD, name });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code, name).toBe('E_NAME');
    }
    const noName = await post('/api/import', { text: GOOD });
    expect(noName.status).toBe(400);
    expect(noName.json.error.code).toBe('E_FIELD');
    expect(readdirSync(path.dirname(projectDir)).filter((f) => f.includes('escape'))).toEqual([]);
  });

  it('hostile files are refused as data: a DOCTYPE with an entity starts nothing and nothing is saved', async () => {
    const r = await post('/api/import', { text: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><opsa-mef name="&e;"/>', name: 'imp-evil' });
    expect(r.json).toMatchObject({ kind: 'refused', errors: [{ code: 'E_XML' }] });
    expect(files().filter((f) => f.startsWith('imp-evil'))).toEqual([]);
  });

  it('the import route needs the request header and a JSON body like every write', async () => {
    const noHeader = await request('POST', '/api/import', { body: JSON.stringify({ text: GOOD, name: 'imp-x' }), headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(403);
    // an oversize body is refused with 413 and the connection closed: the client either reads that answer or, if the server closes while it is
    // still sending, sees the connection reset (which of the two happens is a matter of timing, and both are a refusal)
    const big = await post('/api/import', { text: 'x'.repeat(2.5 * 1024 * 1024), name: 'imp-big' }).then(
      (r) => r.status,
      () => 'connection closed',
    );
    expect([400, 413, 'connection closed']).toContain(big);
    expect(files().filter((f) => f.startsWith('imp-x') || f.startsWith('imp-big'))).toEqual([]);
  });
});

describe('writeImport limits and the request body', () => {
  it('refuses a model, original or note over the size limit, writing nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-wi-'));
    try {
      const big = 'x'.repeat(MAX_MODEL_BYTES + 1);
      for (const f of [{ modelText: big, originalText: 'a', report: 'b' }, { modelText: 'a', originalText: big, report: 'b' }, { modelText: 'a', originalText: 'b', report: big }]) {
        expect(() => writeImport(dir, 'wi', f)).toThrow(StorageError);
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeImport never overwrites or removes what it did not create', () => {
  it('an existing note file of the name stops it and stays untouched; nothing of ours is left', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-wi2-'));
    try {
      writeFileSync(path.join(dir, 'wi.opsa.xml'), 'theirs');
      expect(() => writeImport(dir, 'wi', { modelText: '{}', originalText: 'mine', report: 'r' })).toThrow(/already exists/);
      expect(readFileSync(path.join(dir, 'wi.opsa.xml'), 'utf8')).toBe('theirs');
      expect(readdirSync(dir)).toEqual(['wi.opsa.xml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('queued runs', () => {
  /** An engine stand-in whose runs finish only when told to; records the order they started in. */
  const gate = () => {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const impl = (t: string, opts: AnalyzeOptions): Promise<AnalyzeOutcome> =>
      new Promise((resolve) => {
        const tag = (JSON.parse(t) as { model: { name: string } }).model.name;
        started.push(tag);
        const done = (status: string): void => resolve({ kind: 'ran', runDir: path.join(tmp, 'runs', `run-${tag}`), record: { status } as never });
        finish.set(tag, () => done('completed'));
        opts.signal?.addEventListener('abort', () => done('cancelled'), { once: true });
      });
    return { started, finish, impl };
  };
  const named = (name: string): string => JSON.stringify({ ...ORACLE_MODELS['pra-and'], model: { ...(ORACLE_MODELS['pra-and'] as unknown as { model: object }).model, name } });
  const wait = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };
  const run = (name: string, request_id?: string): Promise<Reply> => post('/api/run', { text: named(name), engine: 'scram', ...(request_id ? { request_id } : {}) });
  const status = async () => (await request('GET', '/api/run/status')).json;

  it('runs wait in order, one at a time, and the status names who is running and who is waiting', async () => {
    const g = gate();
    analyzeImpl = g.impl;
    const a = run('qa', 'req-a');
    await wait(() => g.started.includes('qa'));
    const b = run('qb', 'req-b');
    const c = run('qc', 'req-c');
    await new Promise((r) => setTimeout(r, 100));
    expect(await status()).toEqual({ running: { request_id: 'req-a' }, queued: [{ request_id: 'req-b' }, { request_id: 'req-c' }] });
    expect(g.started).toEqual(['qa']);
    g.finish.get('qa')!();
    expect((await a).json.record.status).toBe('completed');
    await wait(() => g.started.includes('qb'));
    expect(g.started).toEqual(['qa', 'qb']); // c still waits
    g.finish.get('qb')!();
    await wait(() => g.started.includes('qc'));
    g.finish.get('qc')!();
    expect((await b).status).toBe(200);
    expect((await c).status).toBe(200);
    expect(await status()).toEqual({ running: null, queued: [] });
  });

  it('cancelling a waiting request by its id removes only that one; it never reaches the engine', async () => {
    const g = gate();
    analyzeImpl = g.impl;
    const a = run('xa', 'req-a');
    await wait(() => g.started.includes('xa'));
    const b = run('xb', 'req-b');
    const c = run('xc', 'req-c');
    await new Promise((r) => setTimeout(r, 100));
    expect((await post('/api/run/cancel', { request_id: 'req-b' })).json).toEqual({ cancelled: true });
    expect((await b).json).toEqual({ kind: 'dequeued' });
    expect((await post('/api/run/cancel', { request_id: 'req-b' })).json).toEqual({ cancelled: false }); // already gone
    expect((await post('/api/run/cancel', { request_id: 'nobody' })).json).toEqual({ cancelled: false });
    expect(await status()).toEqual({ running: { request_id: 'req-a' }, queued: [{ request_id: 'req-c' }] });
    g.finish.get('xa')!();
    await a;
    await wait(() => g.started.includes('xc'));
    expect(g.started).toEqual(['xa', 'xc']);
    g.finish.get('xc')!();
    expect((await c).status).toBe(200);
  });

  it('cancelling by id aborts the running request and not the waiting one; without an id the running one is aborted', async () => {
    const g = gate();
    analyzeImpl = g.impl;
    const a = run('ya', 'req-a');
    await wait(() => g.started.includes('ya'));
    const b = run('yb', 'req-b');
    await new Promise((r) => setTimeout(r, 100));
    expect((await post('/api/run/cancel', { request_id: 'req-a' })).json).toEqual({ cancelled: true });
    expect((await a).json.record.status).toBe('cancelled');
    await wait(() => g.started.includes('yb'));
    expect((await post('/api/run/cancel', {})).json).toEqual({ cancelled: true }); // no id: the running one (yb)
    expect((await b).json.record.status).toBe('cancelled');
  });

  it('a waiting client that goes away never runs', async () => {
    const g = gate();
    analyzeImpl = g.impl;
    const a = run('za', 'req-a');
    await wait(() => g.started.includes('za'));
    const u = new URL('/api/run', server.url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: JSON_HEADERS });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ text: named('zb'), engine: 'scram', request_id: 'req-gone' }));
    await new Promise<void>((resolve) => void (async () => {
      for (let i = 0; i < 100; i++) {
        if (((await status()).queued as unknown[]).length === 1) return resolve();
        await new Promise((r) => setTimeout(r, 20));
      }
      resolve();
    })());
    req.destroy();
    for (let i = 0; i < 100 && ((await status()).queued as unknown[]).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await status()).queued).toEqual([]);
    g.finish.get('za')!();
    await a;
    await new Promise((r) => setTimeout(r, 100));
    expect(g.started).toEqual(['za']);
  });

  it('too many waiting requests are refused as busy, and a bad request id is a bad request', async () => {
    const g = gate();
    analyzeImpl = g.impl;
    const first = run('qq0', 'req-0');
    await wait(() => g.started.includes('qq0'));
    const waiting = Array.from({ length: 8 }, (_, i) => run(`qq${i + 1}`, `req-${i + 1}`));
    for (let i = 0; i < 100 && ((await status()).queued as unknown[]).length < 8; i++) await new Promise((r) => setTimeout(r, 20));
    const over = await run('qq9', 'req-9');
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe('E_BUSY');
    for (const bad of ['', 'a b', 'x'.repeat(65), '../x', 7]) {
      const r = await post('/api/run', { text: named('bad'), engine: 'scram', request_id: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json.error.code).toBe('E_FIELD');
    }
    expect((await post('/api/run/cancel', { request_id: '../x' })).status).toBe(400);
    // drain: cancel everything
    for (let i = 8; i >= 1; i--) await post('/api/run/cancel', { request_id: `req-${i}` });
    await Promise.all(waiting);
    g.finish.get('qq0')!();
    await first;
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
  });
});

describe('finding an identical saved run', () => {
  const makeServer = async (): Promise<{ url: string; runs: string; close: () => Promise<void>; dir: string }> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-reuse-'));
    const runs = path.join(dir, 'runs');
    mkdirSync(runs, { recursive: true });
    const s = await startServer({ projectDir: path.join(dir, 'm'), runsDir: runs, runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(dir, 's') } }, 0);
    return { url: s.url, runs, dir, close: async () => { await s.close(); rmSync(dir, { recursive: true, force: true }); } };
  };
  const hashOf = async (url: string, t: string): Promise<string> => {
    const r = await fetch(`${url}/api/validate`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: t }) });
    return ((await r.json()) as { model_hash: string }).model_hash;
  };
  const save = (runs: string, id: string, over: Record<string, unknown>): void => {
    mkdirSync(path.join(runs, id, 'native'), { recursive: true });
    writeFileSync(path.join(runs, id, 'results.json'), JSON.stringify({ schema_version: 1, status: 'completed', completeness: 'complete', method: 'exact', top_event_probability: 0.5, ...over }));
    writeFileSync(path.join(runs, id, 'native', 'model.json'), '{"model":{"name":"x"}}');
  };
  const lookup = async (url: string, body: Record<string, unknown>) => {
    const r = await fetch(`${url}/api/run/lookup`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('finds the newest complete run of the same model, method and engine build, and nothing else', async () => {
    const s = await makeServer();
    try {
      const t = text('pra-and');
      const h = await hashOf(s.url, t);
      const eng = { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256 };
      const base = { input_hashes: { model_hash: h }, engine: eng };
      expect((await lookup(s.url, { text: t, method: 'exact', engine: 'builtin' })).json).toEqual({ found: false }); // nothing saved yet
      save(s.runs, '2026-01-01T00-00-00-old-aaaaaaaa', { ...base, top_event_probability: 0.1 });
      save(s.runs, '2026-02-01T00-00-00-new-bbbbbbbb', { ...base, top_event_probability: 0.2 });
      const hit = (await lookup(s.url, { text: t, method: 'exact', engine: 'builtin' })).json;
      expect(hit).toMatchObject({ found: true, run_id: '2026-02-01T00-00-00-new-bbbbbbbb', record: { top_event_probability: 0.2 } });
      expect(typeof hit.saved_at).toBe('string');
      // each of these differs in one respect, so none may be offered
      const miss = async (body: Record<string, unknown>): Promise<void> => expect((await lookup(s.url, body)).json, JSON.stringify(body)).toEqual({ found: false });
      await miss({ text: t, method: 'mcub', engine: 'builtin' }); // another method
      await miss({ text: t, method: 'exact', engine: 'scram' }); // another engine (no SCRAM record, and no runtime)
      await miss({ text: t, method: 'exact', engine: 'both' }); // the cross-check is never reused
      await miss({ text: text('pra-or'), method: 'exact', engine: 'builtin' }); // another model
      await miss({ text: '{nope', method: 'exact', engine: 'builtin' }); // not a model
    } finally {
      await s.close();
    }
  });

  it('searches beyond the newest 100 runs, and does not offer a SCRAM run when no runtime says which build it was', async () => {
    const s = await makeServer();
    try {
      const t = text('pra-and');
      const h = await hashOf(s.url, t);
      const eng = { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256 };
      save(s.runs, '2020-01-01T00-00-00-oldest-aaaaaaaa', { input_hashes: { model_hash: h }, engine: eng });
      for (let i = 0; i < 120; i++) save(s.runs, `2026-01-${String(i).padStart(3, '0')}-other-bbbbbbbb`, { input_hashes: { model_hash: 'f'.repeat(64) }, engine: eng });
      expect((await lookup(s.url, { text: t, method: 'exact', engine: 'builtin' })).json).toMatchObject({ found: true, run_id: '2020-01-01T00-00-00-oldest-aaaaaaaa' });
      save(s.runs, '2027-01-01T00-00-00-scram-cccccccc', { input_hashes: { model_hash: h }, engine: { name: 'SCRAM', version: '0.16.2', sha256: 'a'.repeat(64) } });
      expect((await lookup(s.url, { text: t, method: 'exact', engine: 'scram' })).json).toEqual({ found: false }); // no runtime installed here
    } finally {
      await s.close();
    }
  });

  it('does not offer a run that is truncated, failed, from another engine version, or whose files cannot be read', async () => {
    const s = await makeServer();
    try {
      const t = text('pra-and');
      const h = await hashOf(s.url, t);
      const eng = { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: BDD_SOURCE_SHA256 };
      const base = { input_hashes: { model_hash: h }, engine: eng };
      save(s.runs, 'r1', { ...base, completeness: 'truncated' });
      save(s.runs, 'r2', { ...base, status: 'failed', completeness: 'none' });
      save(s.runs, 'r3', { ...base, status: 'truncated' });
      save(s.runs, 'r4', { ...base, engine: { name: BDD_ENGINE_NAME, version: '0.0.0-other' } });
      save(s.runs, 'r5', { ...base, engine: { name: 'SCRAM', version: BDD_ENGINE_VERSION } });
      save(s.runs, 'r6', { ...base, input_hashes: { model_hash: 'f'.repeat(64) } });
      save(s.runs, 'r8', { ...base, engine: { ...eng, sha256: 'f'.repeat(64) } }); // the same version, another build of the source
      save(s.runs, 'r9', { ...base, engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION, sha256: null } }); // a record from before the build was recorded
      save(s.runs, 'r10', { ...base, engine: { name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION } }); // no build at all
      expect((await lookup(s.url, { text: t, method: 'exact', engine: 'builtin' })).json).toEqual({ found: false });
      save(s.runs, 'r7', base);
      rmSync(path.join(s.runs, 'r7', 'native', 'model.json')); // a run without its model file is not served, so not offered
      expect((await lookup(s.url, { text: t, method: 'exact', engine: 'builtin' })).json).toEqual({ found: false });
    } finally {
      await s.close();
    }
  });

  it('writes nothing and needs the request header and a valid method and engine', async () => {
    const s = await makeServer();
    try {
      const before = readdirSync(s.runs);
      expect((await lookup(s.url, { text: text('pra-and'), method: 'nope' })).status).toBe(400);
      expect((await lookup(s.url, { text: text('pra-and'), engine: 'nope' })).status).toBe(400);
      expect((await lookup(s.url, { method: 'exact' })).status).toBe(400);
      const noHeader = await fetch(`${s.url}/api/run/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text('pra-and') }) });
      expect(noHeader.status).toBe(403);
      expect(readdirSync(s.runs)).toEqual(before);
    } finally {
      await s.close();
    }
  });
});

describe('importance measures over the API', () => {
  const ids = (j: any): string[] => j.events.map((e: { id: string }) => e.id);

  it('gives the exact measures of the model on screen, names the engine and the assumptions, and writes nothing', async () => {
    const before = readdirSync(path.join(tmp, 'runs'), { withFileTypes: true }).length;
    const model = { ...ORACLE_MODELS['pra-or'], events: (ORACLE_MODELS['pra-or']!.events as { id: string; probability: number }[]).map((e, i) => (i === 0 ? { ...e, name: 'Pump A' } : e)) };
    const r = await post('/api/importance', { text: JSON.stringify(model) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'ok', engine: { name: 'sneed-bdd' } });
    expect(r.json.model_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.assumptions).toContain('independent');
    expect(r.json.top).toBeCloseTo(0.28, 12);
    const a = r.json.events.find((e: { id: string }) => e.id === 'A');
    expect(a).toMatchObject({ name: 'Pump A', birnbaum: expect.closeTo(0.8, 12), rrwInfinite: false });
    expect(r.json.events.find((e: { id: string }) => e.id === 'B').name).toBeUndefined();
    expect(readdirSync(path.join(tmp, 'runs'), { withFileTypes: true }).length).toBe(before); // nothing saved
  });

  it('refuses an invalid model with the validator errors, and a request that is not a model text as a bad request', async () => {
    const bad = { ...ORACLE_MODELS['pra-or'], top: 'NOPE' };
    const r = await post('/api/importance', { text: JSON.stringify(bad) });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('refused');
    expect(r.json.errors.length).toBeGreaterThan(0);
    expect((await post('/api/importance', {})).status).toBe(400);
    expect((await post('/api/importance', { text: 5 })).status).toBe(400);
    expect((await post('/api/importance', { text: text('pra-or'), request_id: '../x' })).status).toBe(400);
    const noHeader = await request('POST', '/api/importance', { body: JSON.stringify({ text: text('pra-or') }), headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(403);
  });

  it('says why a table is not made (too many events) instead of a partial table', async () => {
    const events = Array.from({ length: 301 }, (_, i) => ({ id: `E${i}`, probability: 0.01 }));
    const doc = { ...ORACLE_MODELS['pra-or'], top: 'T', events, gates: [{ id: 'T', type: 'or', inputs: events.map((e) => e.id) }] };
    const r = await post('/api/importance', { text: JSON.stringify(doc) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'failed', why: 'too-many-events' });
    expect(r.json.message).toContain('300');
    expect(r.json.events).toBeUndefined();
  });

  it('a numeric range failure is reported as that, in words, and no table', async () => {
    const events = Array.from({ length: 200 }, (_, i) => ({ id: `E${i}`, probability: 0.001 }));
    const doc = { ...ORACLE_MODELS['pra-or'], top: 'T', events, gates: [{ id: 'T', type: 'and', inputs: events.map((e) => e.id) }] };
    const r = await post('/api/importance', { text: JSON.stringify(doc) });
    expect(r.json).toMatchObject({ kind: 'failed', why: 'numeric-range' });
    expect(r.json.message).toContain('too small');
    expect(r.json.events).toBeUndefined();
  });

  it('takes its turn behind a run, can be cancelled while it waits, and the status lists it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    analyzeImpl = async () => {
      started();
      await gate;
      return { kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never };
    };
    const run = post('/api/run', { text: text('pra-and'), engine: 'scram', request_id: 'req-run' });
    await hasStarted;
    const waiting = post('/api/importance', { text: text('pra-or'), request_id: 'req-imp' });
    const doomed = post('/api/importance', { text: text('pra-or'), request_id: 'req-doomed' });
    for (let i = 0; i < 100 && ((await request('GET', '/api/run/status')).json.queued as unknown[]).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await request('GET', '/api/run/status')).json.queued).toEqual([{ request_id: 'req-imp' }, { request_id: 'req-doomed' }]);
    expect((await post('/api/run/cancel', { request_id: 'req-doomed' })).json).toEqual({ cancelled: true });
    expect((await doomed).json).toEqual({ kind: 'dequeued' });
    release();
    await run;
    const done = await waiting;
    expect(done.json.kind).toBe('ok');
    expect(ids(done.json).sort()).toEqual(['A', 'B']);
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
  });

  it('a client that goes away while waiting never gets a table computed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    analyzeImpl = async () => {
      started();
      await gate;
      return { kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never };
    };
    const run = post('/api/run', { text: text('pra-and'), engine: 'scram' });
    await hasStarted;
    const u = new URL('/api/importance', server.url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: JSON_HEADERS });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ text: text('pra-or'), request_id: 'req-gone' }));
    for (let i = 0; i < 100 && ((await request('GET', '/api/run/status')).json.queued as unknown[]).length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    req.destroy();
    for (let i = 0; i < 100 && ((await request('GET', '/api/run/status')).json.queued as unknown[]).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await request('GET', '/api/run/status')).json.queued).toEqual([]);
    release();
    await run;
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
  });
});

describe('event trees over the API (plan 13, stage S1)', () => {
  const put = (url: string, body: unknown): Promise<Reply> => request('PUT', url, { body: JSON.stringify(body), headers: JSON_HEADERS });
  const ASSUME = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' };
  const treeFor = (modelName: string, hash: string): Record<string, unknown> => ({
    schema: { id: 'sneed.event-tree', version: 1 },
    tree: { id: 'et', name: 'Shared supply (example)', created: '2026-10-06T00:00:00Z', updated: '2026-10-06T00:00:00Z' },
    fault_tree_model: { name: modelName, model_hash: hash },
    initiating_event: { name: 'Transient (example)', description: 'An example.', frequency: 0.5, unit: 'per-year' },
    // pra-shared: TOP = AB OR AC, AB = A AND B, AC = A AND C: the two headings share the basic event A
    headings: [{ id: 'H1', name: 'First function', event: 'AB' }, { id: 'H2', name: 'Second function', event: 'AC' }],
    end_states: [{ id: 'OK', name: 'Fine (example)', description: 'Nothing lost (example).', synthetic: true }, { id: 'BAD', name: 'Lost (example)', description: 'Something lost (example).', synthetic: true }],
    sequences: [
      { path: [{ heading: 'H1', branch: 'works' }, { heading: 'H2', branch: 'works' }], end_state: 'OK' },
      { path: [{ heading: 'H1', branch: 'works' }, { heading: 'H2', branch: 'fails' }], end_state: 'BAD' },
      { path: [{ heading: 'H1', branch: 'fails' }, { heading: 'H2', branch: 'works' }], end_state: 'BAD' },
      { path: [{ heading: 'H1', branch: 'fails' }, { heading: 'H2', branch: 'fails' }], end_state: 'BAD' },
    ],
    assumptions: ASSUME,
  });
  const modelHashOf = async (modelText: string): Promise<string> => (await post('/api/validate', { text: modelText })).json.model_hash;

  it('saves a tree in its own folder, lists it apart from the models, and gives back the exact text', async () => {
    const before = (await request('GET', '/api/models')).json.models.length;
    const doc = JSON.stringify(treeFor('et-model', 'a'.repeat(64)), null, 2) + '\n';
    const saved = await put('/api/event-trees/my-tree', { text: doc });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ name: 'my-tree' });
    expect((await request('GET', '/api/event-trees')).json.trees.map((t: { name: string }) => t.name)).toContain('my-tree');
    expect((await request('GET', '/api/event-trees/my-tree')).json.text).toBe(doc);
    expect((await request('GET', '/api/models')).json.models).toHaveLength(before); // not a model
    expect(readdirSync(path.join(projectDir, 'event-trees'))).toContain('my-tree.json');
  });

  it('a tree and a model can have the same name without touching each other', async () => {
    await put('/api/models/same-name', { text: text('pra-and') });
    await put('/api/event-trees/same-name', { text: '{"work":"in progress"}' }); // unfinished work is saved as it is, like a model
    expect(JSON.parse((await request('GET', '/api/models/same-name')).json.text).top).toBe('TOP');
    expect(JSON.parse((await request('GET', '/api/event-trees/same-name')).json.text)).toEqual({ work: 'in progress' });
  });

  it('names are checked like model names, text must be JSON, a missing tree is 404 in its own words, and writes need the header', async () => {
    for (const name of ['../x', 'a/b', '.hidden', 'a..b', 'x'.repeat(65)]) {
      const r = await put(`/api/event-trees/${encodeURIComponent(name)}`, { text: '{}' });
      expect(r.status, name).toBe(400);
      expect(r.json.error.code, name).toBe('E_NAME');
    }
    expect((await put('/api/event-trees/not-json', { text: '{nope' })).json.error.code).toBe('E_NOT_JSON');
    const missing = await request('GET', '/api/event-trees/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toContain('no saved event tree');
    const noHeader = await request('PUT', '/api/event-trees/x', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(403);
    expect((await post('/api/event-tree/validate', {})).status).toBe(400);
  });

  it('validates against the saved fault-tree model: valid, then stale after the model changes, then not found', async () => {
    const modelText = text('pra-shared');
    await put('/api/models/et-model', { text: modelText });
    const hash = await modelHashOf(modelText);
    const doc = JSON.stringify(treeFor('et-model', hash));
    const ok = await post('/api/event-tree/validate', { text: doc });
    expect(ok.json).toMatchObject({ valid: true, errors: [], modelChecked: true });
    expect(ok.json.tree_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.json.document_hash).toMatch(/^[0-9a-f]{64}$/);
    // change the model: the tree pins the hash it was checked against
    const changed = JSON.parse(modelText);
    changed.events[0].probability = 0.5;
    await put('/api/models/et-model', { text: JSON.stringify(changed) });
    const stale = await post('/api/event-tree/validate', { text: doc });
    expect(stale.json.valid).toBe(false);
    expect(stale.json.errors.map((e: { code: string }) => e.code)).toEqual(['E_STALE_MODEL']);
    expect(stale.json.tree_hash).toBeNull();
    expect((await post('/api/event-tree/validate', { text: JSON.stringify(treeFor('no-such-model', hash)) })).json.errors[0].code).toBe('E_MODEL_NOT_FOUND');
  });

  it('a heading naming something the saved model does not have, and a saved model that is itself invalid, are refused', async () => {
    const modelText = text('pra-shared');
    await put('/api/models/et-model2', { text: modelText });
    const hash = await modelHashOf(modelText);
    const bad = treeFor('et-model2', hash) as { headings: { event: string }[] };
    bad.headings[1]!.event = 'NOPE';
    expect((await post('/api/event-tree/validate', { text: JSON.stringify(bad) })).json.errors.map((e: { code: string }) => e.code)).toEqual(['E_UNKNOWN_EVENT']);
    await put('/api/models/broken-model', { text: '{"top":"X"}' }); // saved work in progress: valid JSON, not a valid model
    expect((await post('/api/event-tree/validate', { text: JSON.stringify(treeFor('broken-model', hash)) })).json.errors[0].code).toBe('E_MODEL_NOT_FOUND');
    // a saved model that parses and has gates but is not valid (a gate input that does not exist) is not a model to refer to
    const invalid = JSON.parse(modelText);
    invalid.gates[0].inputs.push('NOWHERE');
    await put('/api/models/invalid-model', { text: JSON.stringify(invalid) });
    expect((await post('/api/event-tree/validate', { text: JSON.stringify(treeFor('invalid-model', hash)) })).json.errors.map((e: { code: string }) => e.code)).toEqual(['E_MODEL_NOT_FOUND']);
    // a model name that is not a model name is "not found", never a file read outside the folder
    expect((await post('/api/event-tree/validate', { text: JSON.stringify(treeFor('../secret', hash)) })).json.errors[0].code).toBe('E_MODEL_NOT_FOUND');
  });

  it('extra fields that cannot be hashed do not make the route fail: a normal answer, with a hash', async () => {
    const modelText = text('pra-shared');
    await put('/api/models/et-model3', { text: modelText });
    const hash = await modelHashOf(modelText);
    const odd = JSON.stringify(treeFor('et-model3', hash)).replace('"schema":{', '"schema":{"extra":1e400,');
    const r = await post('/api/event-tree/validate', { text: odd });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ valid: true });
    expect(r.json.tree_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('text that is not a document is reported as E_SCHEMA, not as a server error', async () => {
    const r = await post('/api/event-tree/validate', { text: '{nope' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ valid: false, errors: [{ code: 'E_SCHEMA' }], tree_hash: null });
  });
});

describe('analysing an event tree over the API (plan 13, stage S2)', () => {
  const put = (url: string, body: unknown): Promise<Reply> => request('PUT', url, { body: JSON.stringify(body), headers: JSON_HEADERS });
  const ASSUME = { frequency_unit: 'per-year', probability_basis: 'per-demand', independence: 'declared-independent', ie_independent_of_events: true, success_branches: 'exact' };
  // pra-shared: TOP = AB OR AC, AB = A AND B, AC = A AND C (A shared): the two headings are AB and AC
  const treeFor = (modelName: string, hash: string): Record<string, any> => ({
    schema: { id: 'sneed.event-tree', version: 1 },
    tree: { id: 'et', name: 'Shared supply (example)', created: '2026-10-06T00:00:00Z', updated: '2026-10-06T00:00:00Z' },
    fault_tree_model: { name: modelName, model_hash: hash },
    initiating_event: { name: 'Transient (example)', description: 'An example.', frequency: 2, unit: 'per-year' },
    headings: [{ id: 'H1', name: 'First function', event: 'AB' }, { id: 'H2', name: 'Second function', event: 'AC' }],
    end_states: [{ id: 'OK', name: 'Fine (example)', description: 'Nothing lost (example).', synthetic: true }, { id: 'BAD', name: 'Lost (example)', description: 'Something lost (example).', synthetic: true }],
    sequences: [
      { path: [{ heading: 'H1', branch: 'works' }, { heading: 'H2', branch: 'works' }], end_state: 'OK' },
      { path: [{ heading: 'H1', branch: 'works' }, { heading: 'H2', branch: 'fails' }], end_state: 'BAD' },
      { path: [{ heading: 'H1', branch: 'fails' }, { heading: 'H2', branch: 'works' }], end_state: 'BAD' },
      { path: [{ heading: 'H1', branch: 'fails' }, { heading: 'H2', branch: 'fails' }], end_state: 'BAD' },
    ],
    assumptions: ASSUME,
  });
  const setup = async (name: string): Promise<{ doc: Record<string, any>; text: string }> => {
    const modelText = text('pra-shared');
    await put(`/api/models/${name}`, { text: modelText });
    const hash = (await post('/api/validate', { text: modelText })).json.model_hash;
    const doc = treeFor(name, hash);
    return { doc, text: JSON.stringify(doc) };
  };

  it('runs the saved model\'s heading events jointly and answers with a record of its own kind, written to a run folder', async () => {
    const { text: tree } = await setup('etrun-model');
    const before = readdirSync(path.join(tmp, 'runs')).length;
    const r = await post('/api/event-tree/run', { text: tree });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('ran');
    const rec = r.json.record;
    expect(rec).toMatchObject({ schema: { id: 'sneed.event-tree-result' }, status: 'completed', completeness: 'complete', approximation: null });
    // A = 0.1 (pra-shared), B = 0.2, C = 0.3: AB = 0.02, AC = 0.03, both = A and B and C = 0.006
    const p = (k: string): number => rec.sequences.find((s: { key: string }) => s.key === k).probability;
    expect(p('H1:fails,H2:fails')).toBeCloseTo(0.006, 14);
    expect(p('H1:fails,H2:works')).toBeCloseTo(0.014, 14);
    expect(p('H1:works,H2:fails')).toBeCloseTo(0.024, 14);
    expect(p('H1:works,H2:works')).toBeCloseTo(0.956, 14);
    expect(rec.total.frequency).toBeCloseTo(2, 14);
    expect(rec.sequences.find((s: { key: string }) => s.key === 'H1:fails,H2:fails').frequency).toBeCloseTo(0.012, 14); // 2 per year x 0.006
    expect(readdirSync(path.join(tmp, 'runs')).length).toBe(before + 1);
    expect(existsSync(path.join(tmp, 'runs', r.json.run_id, 'event-tree-results.json'))).toBe(true);
    // an event-tree run is not a fault-tree run: the saved-run list for Compare and reuse does not list it
    expect((await request('GET', '/api/runs')).json.runs.map((x: { id: string }) => x.id)).not.toContain(r.json.run_id);
  });

  it('the labelled approximation only when asked, and only as a true or false', async () => {
    const { text: tree } = await setup('etrun-model2');
    expect((await post('/api/event-tree/run', { text: tree })).json.record.approximation).toBeNull();
    const asked = await post('/api/event-tree/run', { text: tree, approximation: true });
    expect(asked.json.record.approximation).toMatchObject({ method: 'success-branches-ignored' });
    for (const bad of ['yes', 1, null]) {
      const r = await post('/api/event-tree/run', { text: tree, approximation: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(r.json.error.code).toBe('E_FIELD');
    }
  });

  it('a tree that does not check out is refused before anything is queued or written', async () => {
    const { doc } = await setup('etrun-model3');
    const before = readdirSync(path.join(tmp, 'runs')).length;
    const bad = { ...doc, sequences: doc.sequences.slice(1) };
    const r = await post('/api/event-tree/run', { text: JSON.stringify(bad) });
    expect(r.json).toMatchObject({ kind: 'refused', errors: [{ code: 'E_SEQUENCES_MISSING' }] });
    const stale = { ...doc, fault_tree_model: { ...doc.fault_tree_model, model_hash: 'e'.repeat(64) } };
    expect((await post('/api/event-tree/run', { text: JSON.stringify(stale) })).json.errors.map((e: { code: string }) => e.code)).toEqual(['E_STALE_MODEL']);
    expect((await post('/api/event-tree/run', { text: JSON.stringify({ ...doc, fault_tree_model: { ...doc.fault_tree_model, name: 'no-such-model' } }) })).json.errors[0].code).toBe('E_MODEL_NOT_FOUND');
    expect((await post('/api/event-tree/run', { text: '{nope' })).json.errors[0].code).toBe('E_SCHEMA');
    expect(readdirSync(path.join(tmp, 'runs')).length).toBe(before);
    expect((await post('/api/event-tree/run', {})).status).toBe(400);
    const noHeader = await request('POST', '/api/event-tree/run', { body: JSON.stringify({ text: '{}' }), headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(403);
  });

  it('a running analysis is cancelled by its request id, and the answer is a cancelled record with no numbers', async () => {
    const n = 20;
    const events: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      events[`A${i}`] = 0.1;
      events[`B${i}`] = 0.1;
    }
    const pairs = Array.from({ length: n }, (_, i) => AND(`P${i}`, [`A${i}`, `B${i}`]));
    const heavy = mkDoc('TOP', events, [OR('TOP', ['PA', 'PB', 'F']), OR('PA', Array.from({ length: n }, (_, i) => `A${i}`)), OR('PB', Array.from({ length: n }, (_, i) => `B${i}`)), OR('F', pairs.map((g) => g.id)), ...pairs]);
    await put('/api/models/etheavy', { text: JSON.stringify(heavy) });
    const hash = (await post('/api/validate', { text: JSON.stringify(heavy) })).json.model_hash;
    const heads = [{ id: 'H1', name: 'A side', event: 'PA' }, { id: 'H2', name: 'B side', event: 'PB' }, { id: 'H3', name: 'Pairs', event: 'F' }];
    const doc = treeFor('etheavy', hash);
    doc.headings = heads;
    doc.sequences = skeletonSequences(heads).map((x) => ({ path: x.path, end_state: 'OK' }));
    const started = Date.now();
    const run = post('/api/event-tree/run', { text: JSON.stringify(doc), request_id: 'req-heavy' });
    await new Promise((r) => setTimeout(r, 400));
    expect((await post('/api/run/cancel', { request_id: 'req-heavy' })).json).toEqual({ cancelled: true });
    const done = await run;
    expect(done.json.record).toMatchObject({ status: 'cancelled', reasons: ['cancelled'], sequences: [] });
    expect(Date.now() - started).toBeLessThan(4000); // the model needs seconds: the cancel did not wait for it
  }, 30000);

  it('takes its turn behind a run, can be cancelled while it waits by request id, and the status lists it', async () => {
    const { text: tree } = await setup('etrun-model4');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    analyzeImpl = async () => {
      started();
      await gate;
      return { kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never };
    };
    const run = post('/api/run', { text: text('pra-and'), engine: 'scram', request_id: 'req-run' });
    await hasStarted;
    const waiting = post('/api/event-tree/run', { text: tree, request_id: 'req-et' });
    const doomed = post('/api/event-tree/run', { text: tree, request_id: 'req-doomed' });
    for (let i = 0; i < 100 && ((await request('GET', '/api/run/status')).json.queued as unknown[]).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await request('GET', '/api/run/status')).json.queued).toEqual([{ request_id: 'req-et' }, { request_id: 'req-doomed' }]);
    expect((await post('/api/run/cancel', { request_id: 'req-doomed' })).json).toEqual({ cancelled: true });
    expect((await doomed).json).toEqual({ kind: 'dequeued' });
    release();
    await run;
    expect((await waiting).json.kind).toBe('ran');
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
  });
});

