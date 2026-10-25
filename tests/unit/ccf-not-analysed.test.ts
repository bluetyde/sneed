import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../../src/core/analyze.js';
import { analyzeBuiltin } from '../../src/engines/bdd/analyze.js';
import { analyzeEventTreeBuiltin } from '../../src/engines/bdd/event-tree-analyze.js';
import { exportOpenPsa, ExportError } from '../../src/core/export.js';
import { startServer } from '../../src/server/app.js';
import { unanalysedGroups, validateModelText } from '../../src/core/validate.js';
import { modelHash } from '../../src/core/canonical.js';
import type { NativeModel } from '../../src/core/model.js';

// Plan 15, stage C1: a model with common-cause groups is valid, but no engine expands groups yet (stage C2).
// An engine that ignored the groups would print the independent answer without a word, so every analysis refuses first.

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

describe('a model with common-cause groups is never analysed before the groups are expanded', () => {
  it('the fixture is a valid model with a group, and a plain model has none', () => {
    expect(validateModelText(groupsText).valid).toBe(true);
    expect(unanalysedGroups(JSON.parse(groupsText))).toMatchObject({ code: 'E_CCF_NOT_ANALYSED', severity: 'error' });
    expect(unanalysedGroups(JSON.parse(plainText))).toBeNull();
    expect(unanalysedGroups({ ...JSON.parse(plainText), common_cause_groups: [] })).toBeNull();
  });

  it('the built-in engine refuses, names the code and creates no run folder', async () => {
    const runsDir = temp();
    const out = await analyzeBuiltin(groupsText, { runsDir });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.errors.map((e) => e.code)).toEqual(['E_CCF_NOT_ANALYSED']);
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it('the SCRAM path refuses before the exporter or any WSL call', async () => {
    const runsDir = temp();
    const out = await analyze(groupsText, { runsDir, engine: { distro: 'none', binary: '/none', libs: '', expectedVersion: '0', expectedSha256: '0' } });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.errors.map((e) => e.code)).toEqual(['E_CCF_NOT_ANALYSED']);
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it('the event-tree engine refuses a model with groups', async () => {
    const runsDir = temp();
    const out = await analyzeEventTreeBuiltin('{}', groupsText, { runsDir });
    expect(out.kind).toBe('refused');
    // the tree here is not a tree, so only the check of the model can give this reason: the groups are named, not the tree
    if (out.kind === 'refused') expect(out.errors[0]!.message).toMatch(/common-cause groups/);
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
  });

  it('the Open-PSA exporter refuses, so no file is written without the groups', () => {
    const model = JSON.parse(groupsText) as NativeModel;
    expect(() => exportOpenPsa(model)).toThrow(ExportError);
    expect(() => exportOpenPsa(model)).toThrow(/common-cause groups/);
    expect(() => exportOpenPsa(JSON.parse(plainText) as NativeModel)).not.toThrow();
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

  it('a model with groups has a hash of its own, different from the same model without them', () => {
    const withGroups = JSON.parse(groupsText) as NativeModel;
    const without = { ...withGroups, common_cause_groups: [] };
    expect(modelHash(withGroups as never)).not.toBe(modelHash(without as never));
  });
});
