import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StorageError, listModels, readModel, writeImport, writeModel } from '../../src/server/storage.js';
import { startServer, type RunningServer } from '../../src/server/app.js';

// Storage refuses links (Codex security review, 2026-10-07): a symbolic link or junction in the project folder must not let a name inside a
// storage folder lead outside it. Junctions are used because they can be made without special rights on Windows (file symlinks cannot here);
// a junction is reported by lstat as a link, like a symbolic link, and a name that is a folder is "not a plain file" for the same check.
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-links-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
const junction = (target: string, link: string): void => symlinkSync(path.resolve(target), link, 'junction');
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof StorageError ? e.code : `other:${(e as Error).message}`;
  }
  return 'no error';
};

describe('the storage functions', () => {
  it('still work for a plain folder: save, list, read, and a missing folder is empty', () => {
    const dir = path.join(tmp, 'plain');
    expect(listModels(dir)).toEqual([]);
    writeModel(dir, 'a', '{"a":1}');
    expect(readModel(dir, 'a')).toBe('{"a":1}');
    expect(listModels(dir).map((m) => m.name)).toEqual(['a']);
    writeModel(dir, 'a', '{"a":2}');
    expect(readModel(dir, 'a')).toBe('{"a":2}');
  });

  it('refuse a storage folder that is a link: nothing is listed, read or written through it, and nothing appears in the place it points to', () => {
    const outside = path.join(tmp, 'outside1');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}');
    const linked = path.join(tmp, 'linked-folder');
    junction(outside, linked);
    expect(code(() => listModels(linked))).toBe('E_LINK');
    expect(code(() => readModel(linked, 'secret'))).toBe('E_LINK');
    expect(code(() => writeModel(linked, 'new', '{}'))).toBe('E_LINK');
    expect(code(() => writeImport(linked, 'imp', { modelText: '{}', originalText: '<x/>', report: '' }))).toBe('E_LINK');
    expect(readdirSync(outside)).toEqual(['secret.json']);
  });

  it('refuse a saved file that is a link or not a plain file: not read, not replaced, not listed', () => {
    const dir = path.join(tmp, 'with-links');
    mkdirSync(dir);
    const outside = path.join(tmp, 'outside2');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'inside.txt'), 'x');
    junction(outside, path.join(dir, 'linked.json')); // a name ending in .json that leads outside
    mkdirSync(path.join(dir, 'folder.json')); // a folder with a model-like name
    writeModel(dir, 'real', '{}');
    expect(code(() => readModel(dir, 'linked'))).toBe('E_LINK');
    expect(code(() => readModel(dir, 'folder'))).toBe('E_LINK');
    expect(code(() => writeModel(dir, 'linked', '{"x":1}'))).toBe('E_LINK');
    expect(code(() => writeModel(dir, 'folder', '{"x":1}'))).toBe('E_LINK');
    expect(listModels(dir).map((m) => m.name)).toEqual(['real']);
    expect(readdirSync(outside)).toEqual(['inside.txt']);
    // a new name in the same folder is fine
    expect(code(() => writeModel(dir, 'fresh', '{}'))).toBe('no error');
  });

  it('say so in words', () => {
    const outside = path.join(tmp, 'outside3');
    mkdirSync(outside);
    const linked = path.join(tmp, 'linked-folder-3');
    junction(outside, linked);
    expect(() => readModel(linked, 'x')).toThrow(/link/);
  });
});

describe('the server', () => {
  let server: RunningServer;
  let real: string;
  let root: string;
  let outside: string;
  beforeAll(async () => {
    real = path.join(tmp, 'real-project');
    root = path.join(tmp, 'project-through-a-link');
    outside = path.join(tmp, 'outside-server');
    mkdirSync(real);
    mkdirSync(outside);
    junction(real, root); // the project folder itself may be reached through a link: that is the user's choice
    const staticDir = path.join(tmp, 'web');
    mkdirSync(staticDir);
    writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>SNEED</title>');
    server = await startServer({ projectDir: root, runsDir: path.join(tmp, 'runs'), staticDir, allowedOrigins: ['http://127.0.0.1:5999'], runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 'state') } }, 0);
  });
  afterAll(async () => {
    await server.close();
  });
  const call = (method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const u = new URL(url, server.url);
      const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'content-type': 'application/json', 'x-sneed-request': '1' } }, (res) => {
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
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  it('works when the project folder itself is reached through a link, and the files land in the real folder', async () => {
    expect((await call('PUT', '/api/models/m1', { text: '{"a":1}' })).status).toBe(200);
    expect((await call('GET', '/api/models/m1')).json.text).toBe('{"a":1}');
    expect(existsSync(path.join(real, 'm1.json'))).toBe(true);
  });

  it('refuses a models-style folder below the project folder that is a link: event trees and criteria', async () => {
    junction(outside, path.join(real, 'event-trees'));
    junction(outside, path.join(real, 'th-criteria'));
    for (const [list, one] of [['/api/event-trees', '/api/event-trees/x'], ['/api/th-criteria', '/api/th-criteria/x']] as const) {
      const l = await call('GET', list);
      expect(l.status, list).toBe(400);
      expect(l.json.error.code, list).toBe('E_LINK');
      const put = await call('PUT', one, { text: '{}' });
      expect(put.status, one).toBe(400);
      expect(put.json.error.code, one).toBe('E_LINK');
      expect((await call('GET', one)).json.error.code, one).toBe('E_LINK');
    }
    expect(readdirSync(outside)).toEqual([]); // nothing was written through either link
  });

  it('a criterion is not checked against an event tree reached through a linked folder: it counts as no such tree', async () => {
    const criterion = {
      schema: { id: 'sneed.th-criterion', version: 1 },
      criterion: { id: 'c', name: 'C (example)', description: '', synthetic: true, created: 't', updated: 't' },
      applies_to: { event_tree: { name: 'x', tree_hash: 'c'.repeat(64) }, heading: 'H1' },
      plant: { model_name: 'loop', model_hash: 'a'.repeat(64), mutation_list_hash: null },
      condition: { quantity: 'w', comparison: 'above', limit: 1, unit: 'kg/s', window: { from: 0, to: 1, unit: 's' }, holds: 'throughout' },
    };
    const r = await call('POST', '/api/th-criterion/validate', { text: JSON.stringify(criterion) });
    expect(r.json.errors.map((e: { code: string }) => e.code)).toEqual(['E_NO_TREE']);
  });
});
