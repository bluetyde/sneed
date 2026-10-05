import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AnalyzeOptions, AnalyzeOutcome } from '../../src/core/analyze.js';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { MAX_MODEL_BYTES, isValidModelName, listModels, readModel, writeModel, StorageError } from '../../src/server/storage.js';
import { RuntimeNotInstalledError } from '../../src/runtime/resolve.js';
import { ORACLE_MODELS } from '../oracle/models.js';

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
    const r = await post('/api/run', { text: text('pra-and'), method: 'mcub' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'ran', run_id: 'run-1', record: fakeRecord });
    expect(r.body).not.toContain(tmp);
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0]!.opts.settings).toEqual({ method: 'mcub' });
    expect(analyzeCalls[0]!.text).toBe(text('pra-and'));
  });

  it('defaults to the exact method and refuses an unknown one', async () => {
    analyzeCalls = [];
    await post('/api/run', { text: text('pra-and') });
    expect(analyzeCalls[0]!.opts.settings).toEqual({ method: 'exact' });
    const bad = await post('/api/run', { text: text('pra-and'), method: 'magic' });
    expect(bad.status).toBe(400);
    expect(analyzeCalls).toHaveLength(1);
  });

  it('returns a refusal with the typed errors and no run', async () => {
    analyzeImpl = async () => ({ kind: 'refused', errors: [{ code: 'E_CYCLE', path: '/gates/0', message: 'gate cycle', ids: ['A', 'B'] }], warnings: [] });
    const r = await post('/api/run', { text: text('pra-and') });
    expect(r.json).toMatchObject({ kind: 'refused', errors: [{ code: 'E_CYCLE', ids: ['A', 'B'] }] });
  });

  it('a missing runtime is a 503 with the setup code', async () => {
    analyzeImpl = async () => {
      throw new RuntimeNotInstalledError('x');
    };
    const r = await post('/api/run', { text: text('pra-and') });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('E_SETUP_REQUIRED');
  });

  it('an unexpected failure is a plain 500 without details', async () => {
    analyzeImpl = async () => {
      throw new Error('secret path C:\\Users\\x failed');
    };
    const r = await post('/api/run', { text: text('pra-and') });
    expect(r.status).toBe(500);
    expect(r.body).not.toContain('secret');
  });

  it('one run at a time: a second request is busy, and cancel aborts the first', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    analyzeImpl = (_t, opts) =>
      new Promise((resolve) => {
        signal = opts.signal;
        started();
        opts.signal?.addEventListener('abort', () => resolve({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-cancelled'), record: { status: 'cancelled' } as never }), { once: true });
      });
    const first = post('/api/run', { text: text('pra-and') });
    await hasStarted;
    const second = await post('/api/run', { text: text('pra-and') });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('E_BUSY');
    expect(signal!.aborted).toBe(false);
    expect((await post('/api/run/cancel', {})).json).toEqual({ cancelled: true });
    const done = await first;
    expect(done.json.record.status).toBe('cancelled');
    expect(signal!.aborted).toBe(true);
    expect((await post('/api/run/cancel', {})).json).toEqual({ cancelled: false }); // nothing running now
    analyzeImpl = async () => ({ kind: 'ran', runDir: path.join(tmp, 'runs', 'run-1'), record: fakeRecord as never });
    expect((await post('/api/run', { text: text('pra-and') })).status).toBe(200); // free again
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
    req.end(JSON.stringify({ text: text('pra-and') }));
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