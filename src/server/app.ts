import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadLessons, LessonsUnavailable } from './lessons.js';
import { listRuns, readRun, RunsError } from './runs.js';
import { analyze as realAnalyze, type AnalyzeOptions, type AnalyzeOutcome } from '../core/analyze.js';
import { analyzeBuiltin as realBuiltin, type BuiltinOptions } from '../engines/bdd/analyze.js';
import { BDD_ENGINE_NAME, BDD_ENGINE_VERSION } from '../engines/bdd/solve.js';
import { crossCheck, type CrossCheck, type CrossCheckUnavailable } from '../engines/crosscheck.js';
import { documentHash, modelHash } from '../core/canonical.js';
import type { Method, NativeModel } from '../core/model.js';
import { validateModelText } from '../core/validate.js';
import { RuntimeNotInstalledError, defaultRuntimeEnv, resolveEngine } from '../runtime/resolve.js';
import type { RuntimeEnv } from '../runtime/install.js';
import { importOpenPsa } from '../core/import.js';
import { MAX_MODEL_BYTES, StorageError, listModels, readModel, writeImport, writeModel } from './storage.js';

export const SERVER_NAME = 'sneed';
const MAX_BODY = MAX_MODEL_BYTES + 64 * 1024;
const METHODS: Method[] = ['exact', 'rare-event', 'mcub'];
/** builtin: the decision-diagram engine inside the app (the default, no install). scram: the installed SCRAM runtime. both: run both and report whether they agree. */
const ENGINES = ['builtin', 'scram', 'both'] as const;
type EngineChoice = (typeof ENGINES)[number];

export interface ServerOptions {
  /** Folder that holds the saved models (one JSON file each). */
  projectDir: string;
  /** Folder that holds one directory per run. */
  runsDir: string;
  /** Built web app to serve. Without it only the API is served (the dev server proxies to it). */
  staticDir?: string;
  /** Extra origins allowed to call the API, for example the Vite dev server. Same-origin is always allowed. */
  allowedOrigins?: string[];
  runtimeEnv?: RuntimeEnv;
  /** Lesson files and the oracle file they are checked against. Without both, /api/lessons answers 503. */
  lessonsDir?: string;
  oraclesFile?: string;
  /** Replaced in tests: the built-in engine. */
  builtinFn?: (text: string, opts: BuiltinOptions) => Promise<AnalyzeOutcome>;
  /** Replaced in tests: the SCRAM engine. */
  analyzeFn?: (text: string, opts: AnalyzeOptions) => Promise<AnalyzeOutcome>;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** decodeURIComponent throws on a stray percent sign; that is the caller's mistake (400), not ours. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'E_NAME', 'not a run id');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(text);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new HttpError(415, 'E_CONTENT_TYPE', 'send application/json');
  // read by hand, not with for-await: breaking out of an async iterator destroys the socket before the reply is sent
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return; // discard the rest of an oversized upload without keeping it
      size += chunk.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        reject(new HttpError(413, 'E_TOO_LARGE', 'the request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'E_BAD_JSON', 'the request body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'E_BAD_JSON', 'the request body must be a JSON object');
  return value as Record<string, unknown>;
}

/** A client's name for one run request, so that it can be found in the queue and cancelled. Absent is fine; anything else must be a short plain token. */
function optRequestId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new HttpError(400, 'E_FIELD', 'request_id must be 1 to 64 letters, digits, dashes or underscores');
  return v;
}

function needText(body: Record<string, unknown>): string {
  if (typeof body.text !== 'string') throw new HttpError(400, 'E_FIELD', 'the field "text" must be a string');
  if (Buffer.byteLength(body.text, 'utf8') > MAX_MODEL_BYTES) throw new HttpError(413, 'E_TOO_LARGE', 'the model is larger than the allowed size');
  return body.text;
}

/** Validation result plus the two hashes (model_hash is null when the structure cannot be hashed). */
function validateWithHashes(text: string): Record<string, unknown> {
  const v = validateModelText(text);
  let model_hash: string | null = null;
  try {
    model_hash = modelHash(JSON.parse(text) as NativeModel);
  } catch {
    model_hash = null;
  }
  return { ...v, model_hash, document_hash: documentHash(Buffer.from(text, 'utf8')) };
}

export async function startServer(opts: ServerOptions, port = 0, host = '127.0.0.1'): Promise<RunningServer> {
  const env = opts.runtimeEnv ?? defaultRuntimeEnv();
  const analyzeFn = opts.analyzeFn ?? realAnalyze;
  const builtinFn = opts.builtinFn ?? realBuiltin;
  // One engine run at a time; further requests wait in order (at most MAX_QUEUE of them) instead of being refused.
  interface Job {
    id: number;
    requestId: string | null;
    abort: AbortController;
    /** Set when the job leaves the queue without ever starting (cancelled by its client, or the client went away). */
    dropped: boolean;
    start: () => void;
  }
  let running: Job | null = null;
  const queue: Job[] = [];
  let nextRun = 1;
  const MAX_QUEUE = 8;
  /** Resolves when it is this job's turn. */
  const acquire = (job: Job): Promise<void> =>
    new Promise<void>((resolve) => {
      job.start = resolve;
      if (!running) {
        running = job;
        resolve();
      } else queue.push(job);
    });
  const release = (job: Job): void => {
    if (running !== job) return;
    running = null;
    const next = queue.shift();
    if (next) {
      running = next;
      next.start();
    }
  };
  const dequeue = (job: Job): boolean => {
    const i = queue.indexOf(job);
    if (i < 0) return false;
    queue.splice(i, 1);
    job.dropped = true;
    job.start();
    return true;
  };
  let ownPort = 0;

  const allowedHosts = (): string[] => [`127.0.0.1:${ownPort}`, `localhost:${ownPort}`, `[::1]:${ownPort}`];
  const allowedOrigins = (): string[] => [...allowedHosts().map((h) => `http://${h}`), ...(opts.allowedOrigins ?? [])];

  const runtimeInfo = (): Record<string, unknown> => {
    try {
      const e = resolveEngine(env);
      return { installed: true, install_id: e.runtime?.install_id ?? null, recipe_revision: e.runtime?.recipe_revision ?? null, engine_version: e.expectedVersion };
    } catch (err) {
      return { installed: false, code: err instanceof RuntimeNotInstalledError ? err.code : 'E_RUNTIME', message: (err as Error).message };
    }
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const p = url.pathname;
    if (method !== 'GET' && method !== 'HEAD' && req.headers['x-sneed-request'] !== '1') throw new HttpError(403, 'E_CSRF', 'missing the X-SNEED-Request header');

    if (p === '/api/health' && method === 'GET') {
      const scram = runtimeInfo();
      return send(res, 200, { name: SERVER_NAME, runtime: scram, engines: { builtin: { available: true, name: BDD_ENGINE_NAME, version: BDD_ENGINE_VERSION }, scram } });
    }

    if (p === '/api/validate' && method === 'POST') return send(res, 200, validateWithHashes(needText(await readJson(req))));

    if (p === '/api/lessons' && method === 'GET') {
      if (!opts.lessonsDir || !opts.oraclesFile) throw new HttpError(503, 'E_LESSONS_UNAVAILABLE', 'lessons are not configured');
      return send(res, 200, { lessons: loadLessons(opts.lessonsDir, opts.oraclesFile) });
    }

    if (p === '/api/runs' && method === 'GET') return send(res, 200, { runs: listRuns(opts.runsDir) });
    const rm = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (rm && method === 'GET') return send(res, 200, readRun(opts.runsDir, safeDecode(rm[1]!)));

    if (p === '/api/import' && method === 'POST') {
      const body = await readJson(req);
      const text = needText(body);
      const name = body.name;
      if (typeof name !== 'string') throw new HttpError(400, 'E_FIELD', 'name must be a string');
      const result = importOpenPsa(text);
      if (!result.ok) return send(res, 200, { kind: 'refused', errors: result.errors });
      const doc = result.doc as { top: string; events: unknown[]; gates: unknown[] };
      const report = JSON.stringify({ importer: result.importer, source_sha256: result.sourceSha256, notes: result.notes }, null, 2) + '\n';
      writeImport(opts.projectDir, name, { modelText: result.text, originalText: text, report });
      return send(res, 200, { kind: 'imported', name, notes: result.notes, summary: { top: doc.top, events: doc.events.length, gates: doc.gates.length }, source_sha256: result.sourceSha256 });
    }

    if (p === '/api/models' && method === 'GET') return send(res, 200, { models: listModels(opts.projectDir) });
    const m = /^\/api\/models\/([^/]+)$/.exec(p);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      if (method === 'GET') return send(res, 200, { name, text: readModel(opts.projectDir, name) });
      if (method === 'PUT') {
        const info = writeModel(opts.projectDir, name, needText(await readJson(req)));
        return send(res, 200, info);
      }
    }

    if (p === '/api/run' && method === 'POST') {
      const body = await readJson(req);
      const text = needText(body);
      const chosen = (body.method ?? 'exact') as Method;
      if (!METHODS.includes(chosen)) throw new HttpError(400, 'E_FIELD', `the method must be one of ${METHODS.join(', ')}`);
      const engine = (body.engine ?? 'builtin') as EngineChoice;
      if (!ENGINES.includes(engine)) throw new HttpError(400, 'E_FIELD', `the engine must be one of ${ENGINES.join(', ')}`);
      const requestId = optRequestId(body.request_id);
      if (queue.length >= MAX_QUEUE) throw new HttpError(409, 'E_BUSY', `${MAX_QUEUE} runs are already waiting; try again when one has finished`);
      const job: Job = { id: nextRun++, requestId, abort: new AbortController(), dropped: false, start: () => undefined };
      res.on('close', () => {
        if (res.writableEnded) return;
        if (!dequeue(job)) job.abort.abort(); // the browser went away: leave the queue, or stop the engine
      });
      await acquire(job);
      if (job.dropped) {
        if (!res.writableEnded && !res.destroyed) return send(res, 200, { kind: 'dequeued' });
        return;
      }
      try {
        const common = { runsDir: opts.runsDir, settings: { method: chosen }, signal: job.abort.signal };
        const out = engine === 'scram' ? await analyzeFn(text, common) : await builtinFn(text, common);
        if (out.kind === 'refused') return send(res, 200, { kind: 'refused', errors: out.errors, warnings: out.warnings });
        let cross: CrossCheck | CrossCheckUnavailable | undefined;
        if (engine === 'both') {
          // the second opinion is SCRAM's. Without the runtime there is no second opinion, and the reply says so instead of failing.
          const rt = runtimeInfo();
          if (rt.installed !== true) cross = { unavailable: true, reason: String(rt.message ?? 'the SCRAM runtime is not installed') };
          else {
            const other = await analyzeFn(text, common);
            cross = other.kind === 'ran' ? crossCheck(out.record, other.record) : { unavailable: true, reason: 'SCRAM refused the model' };
          }
        }
        return send(res, 200, { kind: 'ran', run_id: path.basename(out.runDir), record: out.record, ...(cross ? { cross } : {}) });
      } finally {
        release(job);
      }
    }
    if (p === '/api/run/lookup' && method === 'POST') {
      // Is there already a saved result for exactly this run? Same model (by its hash), method and engine build, and a complete
      // answer. "both" is never reused (the cross-check is not saved). Nothing is run and nothing is written.
      const body = await readJson(req);
      const text = needText(body);
      const chosen = (body.method ?? 'exact') as Method;
      if (!METHODS.includes(chosen)) throw new HttpError(400, 'E_FIELD', `the method must be one of ${METHODS.join(', ')}`);
      const engine = (body.engine ?? 'builtin') as EngineChoice;
      if (!ENGINES.includes(engine)) throw new HttpError(400, 'E_FIELD', `the engine must be one of ${ENGINES.join(', ')}`);
      const none = { found: false };
      if (engine === 'both' || !validateModelText(text).valid) return send(res, 200, none);
      let hash: string;
      try {
        hash = modelHash(JSON.parse(text) as NativeModel);
      } catch {
        return send(res, 200, none);
      }
      const rt = engine === 'scram' ? runtimeInfo() : null;
      const wantName = engine === 'scram' ? 'SCRAM' : BDD_ENGINE_NAME;
      const wantVersion = engine === 'scram' ? (rt?.installed === true ? String(rt.engine_version) : null) : BDD_ENGINE_VERSION;
      if (wantVersion === null) return send(res, 200, none);
      const hit = listRuns(opts.runsDir).find((r) => r.model_hash === hash && r.method === chosen && r.status === 'completed' && r.completeness === 'complete' && r.engine_name === wantName && r.engine_version === wantVersion);
      if (!hit) return send(res, 200, none);
      try {
        const saved = readRun(opts.runsDir, hit.id);
        return send(res, 200, { found: true, run_id: hit.id, saved_at: hit.modified, record: saved.record });
      } catch {
        return send(res, 200, none); // unreadable now: run it again
      }
    }
    if (p === '/api/run/status' && method === 'GET') {
      return send(res, 200, { running: running ? { request_id: running.requestId } : null, queued: queue.map((j) => ({ request_id: j.requestId })) });
    }
    if (p === '/api/run/cancel' && method === 'POST') {
      const body = await readJson(req);
      const rid = optRequestId(body.request_id);
      if (rid !== null) {
        // a named request: cancel exactly that one, whether it is waiting or running
        const waiting = queue.find((j) => j.requestId === rid);
        if (waiting) return send(res, 200, { cancelled: dequeue(waiting) });
        if (running && running.requestId === rid) {
          running.abort.abort();
          return send(res, 200, { cancelled: true });
        }
        return send(res, 200, { cancelled: false });
      }
      if (!running) return send(res, 200, { cancelled: false });
      running.abort.abort();
      return send(res, 200, { cancelled: true });
    }
    throw new HttpError(404, 'E_NOT_FOUND', 'no such API route');
  }

  function serveStatic(res: http.ServerResponse, url: URL): void {
    const root = opts.staticDir;
    if (!root || !existsSync(root)) throw new HttpError(404, 'E_NO_UI', 'the web app is not built: run `npm run build:web`');
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes('\0')) throw new HttpError(400, 'E_PATH', 'bad path');
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(root, '.' + rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new HttpError(403, 'E_PATH', 'outside the web root');
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (path.extname(rel)) throw new HttpError(404, 'E_NOT_FOUND', 'not found');
      file = path.join(root, 'index.html'); // single-page app route
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' });
    res.end(readFileSync(file));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const hostHeader = String(req.headers.host ?? '');
        if (!allowedHosts().includes(hostHeader.toLowerCase())) throw new HttpError(421, 'E_HOST', 'unexpected Host header');
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins().includes(origin)) throw new HttpError(403, 'E_ORIGIN', 'cross-origin request refused');
        const url = new URL(req.url ?? '/', `http://${hostHeader}`);
        if (url.pathname.startsWith('/api/')) return await api(req, res, url);
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'E_METHOD', 'method not allowed');
        return serveStatic(res, url);
      } catch (e) {
        if (res.headersSent) return void res.end();
        if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } }, e.status === 413 ? { connection: 'close' } : {});
        if (e instanceof StorageError) return send(res, e.code === 'E_NOT_FOUND' ? 404 : e.code === 'E_TOO_LARGE' ? 413 : e.code === 'E_EXISTS' ? 409 : 400, { error: { code: e.code, message: e.message } });
        if (e instanceof RunsError) return send(res, e.code === 'E_NOT_FOUND' ? 404 : e.code === 'E_NAME' ? 400 : 422, { error: { code: e.code, message: e.message } });
        if (e instanceof LessonsUnavailable) return send(res, 503, { error: { code: e.code, message: e.message } });
        if (e instanceof RuntimeNotInstalledError) return send(res, 503, { error: { code: e.code, message: e.message } });
        // never leak a stack or a path to the browser
        return send(res, 500, { error: { code: 'E_INTERNAL', message: 'internal error' } });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  ownPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${ownPort}`,
    port: ownPort,
    close: () =>
      new Promise<void>((resolve) => {
        running?.abort.abort();
        for (const j of [...queue]) dequeue(j);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
