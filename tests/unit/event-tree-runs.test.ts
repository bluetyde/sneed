import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { listEventTreeRuns, listRuns, readEventTreeRun, RunsError } from '../../src/server/runs.js';

let tmp: string;
let runs: string;
let server: RunningServer;

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: { id: 'sneed.event-tree-result', version: 1 },
  status: 'completed',
  completeness: 'complete',
  engine: { name: 'sneed-bdd', version: '0.1.0' },
  input_hashes: { tree_hash: 't1', model_hash: 'm1', document_hash: 'd1' },
  initiating_event: { name: 'Loss of supply', frequency: 0.5, unit: 'per-year' },
  total: { frequency: 0.5, probability_sum: 1, partition_error: 0 },
  sequences: [],
  end_states: [],
  ...over,
});
const put = (id: string, rec: unknown, tree?: unknown): void => {
  mkdirSync(path.join(runs, id, 'native'), { recursive: true });
  writeFileSync(path.join(runs, id, 'event-tree-results.json'), typeof rec === 'string' ? rec : JSON.stringify(rec));
  if (tree !== undefined) writeFileSync(path.join(runs, id, 'native', 'event-tree.json'), JSON.stringify(tree));
};
const get = async (p: string): Promise<{ status: number; json: any }> => {
  const r = await fetch(server.url + p);
  return { status: r.status, json: await r.json().catch(() => null) };
};

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sneed-etruns-'));
  runs = path.join(tmp, 'runs');
  mkdirSync(runs, { recursive: true });
  const staticDir = path.join(tmp, 'web');
  mkdirSync(staticDir);
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>x</title>');
  put('2026-10-06T10-00-00-et-aaaaaaaa-111111', record(), { tree: { name: 'First tree' } });
  put('2026-10-06T11-00-00-et-bbbbbbbb-222222', record({ total: { frequency: 0.25 } }), { tree: { name: 'Second tree' } });
  put('2026-10-06T12-00-00-et-cccccccc-333333', record({ status: 'failed', completeness: 'unknown', total: null }));
  server = await startServer({ projectDir: path.join(tmp, 'models'), runsDir: runs, staticDir, runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 'state') } }, 0);
});
afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('saved event-tree analyses (plan 13, stage S4)', () => {
  it('are listed newest first with what the Compare list shows', () => {
    const list = listEventTreeRuns(runs);
    expect(list.map((r) => r.id)).toEqual(['2026-10-06T12-00-00-et-cccccccc-333333', '2026-10-06T11-00-00-et-bbbbbbbb-222222', '2026-10-06T10-00-00-et-aaaaaaaa-111111']);
    const second = list[1]!;
    expect(second).toMatchObject({ status: 'completed', completeness: 'complete', tree_name: 'Second tree', initiating_event: 'Loss of supply', frequency: 0.5, total_frequency: 0.25, tree_hash: 't1', model_hash: 'm1', engine_name: 'sneed-bdd', engine_version: '0.1.0' });
    expect(list[0]).toMatchObject({ status: 'failed', total_frequency: null, tree_name: null }); // a failed run has no total, and no document file is not an error
  });

  it('the limit is honoured', () => {
    expect(listEventTreeRuns(runs, 2)).toHaveLength(2);
    expect(listEventTreeRuns(path.join(tmp, 'nowhere'))).toEqual([]);
  });

  it('never include fault-tree runs, and the fault-tree list never includes them', () => {
    mkdirSync(path.join(runs, 'ft-run-1', 'native'), { recursive: true });
    writeFileSync(path.join(runs, 'ft-run-1', 'results.json'), JSON.stringify({ schema_version: 1, status: 'completed' }));
    expect(listEventTreeRuns(runs).map((r) => r.id)).not.toContain('ft-run-1');
    expect(listRuns(runs).map((r) => r.id)).toEqual(['ft-run-1']);
  });

  it('leave out a folder whose record is unreadable, of another kind, or of another version, without failing the rest', () => {
    put('bad-json-run-1', '{ not json');
    put('other-kind-run', { schema: { id: 'sneed.fault-tree', version: 1 } });
    put('other-version-run', { schema: { id: 'sneed.event-tree-result', version: 2 } });
    put('array-run-1', '[]');
    const ids = listEventTreeRuns(runs).map((r) => r.id);
    expect(ids).toHaveLength(3);
    for (const bad of ['bad-json-run-1', 'other-kind-run', 'other-version-run', 'array-run-1']) expect(ids).not.toContain(bad);
  });

  it('read back as the record, and a missing or unreadable one is a named error', () => {
    expect((readEventTreeRun(runs, '2026-10-06T11-00-00-et-bbbbbbbb-222222').record as { total: { frequency: number } }).total.frequency).toBe(0.25);
    expect(() => readEventTreeRun(runs, 'no-such-run')).toThrow(RunsError);
    try {
      readEventTreeRun(runs, 'no-such-run');
    } catch (e) {
      expect((e as RunsError).code).toBe('E_NOT_FOUND');
    }
    for (const id of ['bad-json-run-1', 'other-kind-run', 'ft-run-1']) {
      try {
        readEventTreeRun(runs, id);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as RunsError).code).toBe('E_UNREADABLE');
      }
    }
    for (const id of ['../x', '..', 'a/b', 'a\\b', 'x.']) expect(() => readEventTreeRun(runs, id)).toThrow(/not a run id/);
  });

  it('a link inside a run folder is not followed', () => {
    mkdirSync(path.join(runs, 'linked-run-1'));
    writeFileSync(path.join(tmp, 'outside.json'), JSON.stringify(record()));
    try {
      symlinkSync(path.join(tmp, 'outside.json'), path.join(runs, 'linked-run-1', 'event-tree-results.json'));
    } catch {
      return; // creating a link needs a privilege on some Windows set-ups: the check is made where it can be
    }
    expect(listEventTreeRuns(runs).map((r) => r.id)).not.toContain('linked-run-1');
    expect(() => readEventTreeRun(runs, 'linked-run-1')).toThrow(RunsError);
  });

  it('an oversize record is refused, not served', () => {
    put('huge-run-1', record({ pad: 'x'.repeat(4 * 1024 * 1024 + 10) }));
    expect(listEventTreeRuns(runs).map((r) => r.id)).not.toContain('huge-run-1');
    expect(() => readEventTreeRun(runs, 'huge-run-1')).toThrow(RunsError);
  });

  it('are served over the API, listed and read, with the same name rules and status codes as runs', async () => {
    const list = await get('/api/event-tree-runs');
    expect(list.status).toBe(200);
    expect(list.json.runs.length).toBeGreaterThanOrEqual(3);
    const one = await get('/api/event-tree-runs/2026-10-06T11-00-00-et-bbbbbbbb-222222');
    expect(one.status).toBe(200);
    expect(one.json.record.total.frequency).toBe(0.25);
    expect((await get('/api/event-tree-runs/no-such-run')).status).toBe(404);
    expect((await get('/api/event-tree-runs/bad-json-run-1')).status).toBe(422);
    expect((await get('/api/event-tree-runs/..%2Fx')).status).toBe(400);
    // a fault-tree run is not an event-tree run
    expect((await get('/api/event-tree-runs/ft-run-1')).status).toBe(422);
  });

  it('are read only: no other method is served', async () => {
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await fetch(server.url + '/api/event-tree-runs/2026-10-06T11-00-00-et-bbbbbbbb-222222', { method: m, headers: { 'x-sneed-request': '1', 'content-type': 'application/json' }, body: m === 'DELETE' ? undefined : '{}' });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    utimesSync(path.join(runs, '2026-10-06T11-00-00-et-bbbbbbbb-222222'), new Date(), new Date());
    expect(listEventTreeRuns(runs).some((r) => r.id === '2026-10-06T11-00-00-et-bbbbbbbb-222222')).toBe(true);
  });
});
