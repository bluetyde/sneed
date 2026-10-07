import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modelHash } from '../../src/core/canonical.js';
import * as E from '../../src/web/model/event-tree-doc.js';
import { AND, mkDoc, OR } from '../oracle/models.js';

// The event-tree verbs as SEED would start them: the BUILT JavaScript, as a separate process (so the schema file, the worker thread and the
// module paths are the built ones). The runner is built into a private folder inside the repository (so node_modules resolves) and never
// touches dist/, which other tests and the app use.

const ROOT = path.resolve(import.meta.dirname, '../..');
let build: string;
let entry: string;
const MODEL = mkDoc('TOP', { S: 0.1, a: 0.2, b: 0.3 }, [AND('TOP', ['X', 'Y']), OR('X', ['S', 'a']), OR('Y', ['S', 'b'])]);

beforeAll(() => {
  build = mkdtempSync(path.join(ROOT, '.cli-build-'));
  const tsc = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'tsconfig.cli.json'), '--outDir', path.join(build, 'node')], { cwd: ROOT, encoding: 'utf8' });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
  cpSync(path.join(ROOT, 'schema'), path.join(build, 'schema'), { recursive: true });
  entry = path.join(build, 'node', 'cli', 'headless.js');
  expect(existsSync(entry)).toBe(true);
}, 180_000);
afterAll(() => rmSync(build, { recursive: true, force: true }));

function cli(args: string[]): { code: number | null; json: any } {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 110_000 });
  expect(r.stdout.trim().split('\n'), r.stderr).toHaveLength(1); // one JSON object, nothing else
  return { code: r.status, json: JSON.parse(r.stdout) };
}

function fixture(): { dir: string; tree: string; model: string; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sneed-headless-et-built-'));
  const model = path.join(dir, 'model.json');
  writeFileSync(model, JSON.stringify(MODEL, null, 2) + '\n');
  let d = E.newEventTree({ name: 'shared', hash: modelHash(MODEL as never), top: 'X' }, 'Shared case', '2026-10-07T00:00:00Z');
  d = E.setInitiating(d, { frequency: 0.5 });
  d = E.addHeading(d, 'Y');
  d = E.setUnsetEnds(d, 'ES1');
  const tree = path.join(dir, 'tree.json');
  writeFileSync(tree, E.serialize(d));
  const out = path.join(dir, 'out');
  mkdirSync(out);
  return { dir, tree, model, out };
}

describe('the built runner, event-tree verbs', () => {
  it('describe-event-trees', () => {
    const r = cli(['describe-event-trees']);
    expect(r.code).toBe(0);
    expect(r.json.documentFormat).toEqual({ format: 'sneed.event-tree', version: '1' });
    expect(r.json.engine.name).toBe('sneed-bdd');
    expect(r.json.engine.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validate-event-tree reads the built schema file, and refuses a stale tree', () => {
    const f = fixture();
    try {
      const ok = cli(['validate-event-tree', f.tree, '--model', f.model]);
      expect(ok.code).toBe(0);
      expect(ok.json.treeHash).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(f.model, JSON.stringify(mkDoc('TOP', { S: 0.2, a: 0.2, b: 0.3 }, [AND('TOP', ['X', 'Y']), OR('X', ['S', 'a']), OR('Y', ['S', 'b'])]), null, 2));
      const stale = cli(['validate-event-tree', f.tree, '--model', f.model]);
      expect(stale.code).toBe(2);
      expect(stale.json.errors[0].code).toBe('E_STALE_MODEL');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('run-event-tree runs the worker thread from the built files and writes the hand numbers', () => {
    const f = fixture();
    try {
      const r = cli(['run-event-tree', f.tree, '--model', f.model, '--out', f.out, '--approximation']);
      expect(r.json).toMatchObject({ ok: true, status: 'completed', runId: 'et' });
      expect(r.code).toBe(0);
      const dir = path.join(f.out, 'et');
      expect(readdirSync(dir).sort()).toEqual(['event-tree-results.json', 'event-tree.json', 'manifest.json', 'model.json']);
      const rec = JSON.parse(readFileSync(path.join(dir, 'event-tree-results.json'), 'utf8'));
      const freq = (k: string): number => rec.sequences.find((s: { key: string }) => s.key === k).frequency;
      expect(freq('H1:fails,H2:fails')).toBeCloseTo(0.077, 12);
      expect(freq('H1:fails,H2:works')).toBeCloseTo(0.063, 12);
      expect(rec.approximation.method).toBe('success-branches-ignored');
      expect(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).engine.runtime).toBeNull();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 120_000);
});
