import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeBuiltin } from '../../src/engines/bdd/analyze.js';
import { analyzeEventTreeBuiltin } from '../../src/engines/bdd/event-tree-analyze.js';
import { startServer } from '../../src/server/app.js';
import { unanalysedGroups, validateModelText } from '../../src/core/validate.js';
import { modelHash } from '../../src/core/canonical.js';
import type { NativeModel } from '../../src/core/model.js';

// Plan 15: a model with common-cause groups is valid. The fault-tree analyses (built-in at stage C2, SCRAM and the export at stage C3) expand groups.
// An engine that ignored the groups would print the independent answer without a word, so event trees and importance measures refuse first,
// with E_CCF_NOT_ANALYSED, until their own stage.

const groupsText = readFileSync(path.join(import.meta.dirname, '../../schema/vectors/good/ccf-pair.json'), 'utf8');
const plainText = readFileSync(path.join(import.meta.dirname, '../../schema/vectors/good/pump3-shared.json'), 'utf8');

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'sneed-ccf-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('event trees and importance measures refuse a model with common-cause groups, and the server says so', () => {
  it('the fixture is a valid model with a group, and a plain model has none', () => {
    expect(validateModelText(groupsText).valid).toBe(true);
    expect(unanalysedGroups(JSON.parse(groupsText))).toMatchObject({ code: 'E_CCF_NOT_ANALYSED', severity: 'error' });
    expect(unanalysedGroups(JSON.parse(plainText))).toBeNull();
    expect(unanalysedGroups({ ...JSON.parse(plainText), common_cause_groups: [] })).toBeNull();
  });

  it('the built-in fault-tree analysis is the one that does handle groups (plan 15, stage C2)', async () => {
    const runsDir = temp();
    const out = await analyzeBuiltin(groupsText, { runsDir });
    expect(out.kind).toBe('ran');
    if (out.kind === 'ran') expect(out.record).toMatchObject({ status: 'completed', completeness: 'complete', common_cause: { method: 'beta-factor' } });
  });

  it('the event-tree engine refuses a model with groups', async () => {
    const runsDir = temp();
    const out = await analyzeEventTreeBuiltin('{}', groupsText, { runsDir });
    expect(out.kind).toBe('refused');
    // the tree here is not a tree, so only the check of the model can give this reason: the groups are named, not the tree
    if (out.kind === 'refused') expect(out.errors[0]!.message).toMatch(/common-cause groups/);
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
  });

  it('the importance route refuses and computes nothing', async () => {
    const dir = temp();
    const s = await startServer({ projectDir: path.join(dir, 'm'), runsDir: path.join(dir, 'r'), runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(dir, 's') } }, 0);
    try {
      const res = await fetch(`${s.url}/api/importance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sneed-request': '1' }, body: JSON.stringify({ text: groupsText }) });
      const json = (await res.json()) as { kind: string; errors: { code: string }[] };
      expect(json.kind).toBe('refused');
      expect(json.errors.map((e) => e.code)).toEqual(['E_CCF_NOT_ANALYSED']);
    } finally {
      await s.close();
    }
  });

  it('over the API: the built-in engine runs it, and the SCRAM engine is given the expansion', async () => {
    const dir = temp();
    const s = await startServer({ projectDir: path.join(dir, 'm'), runsDir: path.join(dir, 'r'), runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(dir, 's') } }, 0);
    try {
      const post = async (body: unknown): Promise<any> => (await fetch(`${s.url}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sneed-request': '1' }, body: JSON.stringify(body) })).json();
      const built = await post({ text: groupsText });
      expect(built).toMatchObject({ kind: 'ran', record: { status: 'completed', completeness: 'complete', common_cause: { groups: [{ id: 'G', beta: 0.1 }] } } });
      expect(built.record.top_event_probability).toBeCloseTo(0.018019, 12);
      const scram = await post({ text: groupsText, engine: 'scram' });
      expect(scram.kind).not.toBe('refused'); // SCRAM takes the expansion too (stage C3); with no runtime here the run ends as a failed record
    } finally {
      await s.close();
    }
  });

  it('a model with groups has a hash of its own, different from the same model without them', () => {
    const withGroups = JSON.parse(groupsText) as NativeModel;
    const without = { ...withGroups, common_cause_groups: [] };
    expect(modelHash(withGroups as never)).not.toBe(modelHash(without as never));
  });
});
