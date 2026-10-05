import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadLessons, LessonsUnavailable } from './lessons.js';
import { analyze as realAnalyze, type AnalyzeOptions, type AnalyzeOutcome } from '../core/analyze.js';
import { documentHash, modelHash } from '../core/canonical.js';
import type { Method, NativeModel } from '../core/model.js';
import { validateModelText } from '../core/validate.js';
import { RuntimeNotInstalledError, defaultRuntimeEnv, resolveEngine } from '../runtime/resolve.js';
import type { RuntimeEnv } from '../runtime/install.js';
import { MAX_MODEL_BYTES, StorageError, listModels, readModel, writeModel } from './storage.js';

export const SERVER_NAME = 'sneed';
const MAX_BODY = MAX_MODEL_BYTES + 64 * 1024;
const METHODS: Method[] = ['exact', 'rare-event', 'mcub'];

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
  /** Replaced in tests. */
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
  let running: { id: number; abort: AbortController } | null = null;
  let nextRun = 1;
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

    if (p === '/api/health' && method === 'GET') return send(res, 200, { name: SERVER_NAME, runtime: runtimeInfo() });

    if (p === '/api/validate' && method === 'POST') return send(res, 200, validateWithHashes(needText(await readJson(req))));

    if (p === '/api/lessons' && method === 'GET') {
      if (!opts.lessonsDir || !opts.oraclesFile) throw new HttpError(503, 'E_LESSONS_UNAVAILABLE', 'lessons are not configured');
      return send(res, 200, { lessons: loadLessons(opts.lessonsDir, opts.oraclesFile) });
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
      if (running) throw new HttpError(409, 'E_BUSY', 'a run is already in progress');
      const job = { id: nextRun++, abort: new AbortController() };
      running = job;
      res.on('close', () => {
        if (!res.writableEnded) job.abort.abort(); // the browser went away: stop the engine
      });
      try {
        const out = await analyzeFn(text, { runsDir: opts.runsDir, settings: { method: chosen }, signal: job.abort.signal });
        if (out.kind === 'refused') return send(res, 200, { kind: 'refused', errors: out.errors, warnings: out.warnings });
        return send(res, 200, { kind: 'ran', run_id: path.basename(out.runDir), record: out.record });
      } finally {
        if (running === job) running = null;
      }
    }
    if (p === '/api/run/cancel' && method === 'POST') {
      await readJson(req);
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
        if (e instanceof StorageError) return send(res, e.code === 'E_NOT_FOUND' ? 404 : e.code === 'E_TOO_LARGE' ? 413 : 400, { error: { code: e.code, message: e.message } });
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
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
