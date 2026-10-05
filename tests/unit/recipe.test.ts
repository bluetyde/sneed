import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecipeError, checkRecipe, effectiveCommand, loadRecipe, type Recipe, type RecipeErrorCode } from '../../src/runtime/recipe.js';
import { enumerate } from '../oracle/enumerate.js';
import { mkDoc } from '../oracle/models.js';

const dir = path.resolve(import.meta.dirname, '../../runtime');
const loaded = loadRecipe(dir);
const clone = (): Recipe => JSON.parse(JSON.stringify(loaded.recipe)) as Recipe;
const require_sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const codes = (r: unknown, lock = loaded.lockText): string[] => [...new Set(checkRecipe(r, lock).map((i) => i.code))].sort();

describe('the shipped SCRAM recipe', () => {
  it('loads and passes every check', () => {
    expect(loaded.recipe.artifact).toMatchObject({ id: 'scram', version: '0.16.2', recipe_revision: 1 });
    expect(loaded.recipe.trust.source_commit).toBe('9c9a75ca0c5c2fbb5b4a7d32e29fd25bf90f7bab');
    expect(checkRecipe(loaded.recipe, loaded.lockText)).toEqual([]);
    expect(loaded.recipeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the toolchain lock is a conda explicit file where every package carries a sha256', () => {
    const lines = loaded.lockText.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines[0]).toBe('@EXPLICIT');
    expect(lines.length - 1).toBe(48);
    for (const l of lines.slice(1)) expect(l, l).toMatch(/^https:\/\/conda\.anaconda\.org\/conda-forge\/.+#[0-9a-f]{64}$/);
    expect(loaded.lockSha256).toBe(loaded.recipe.trust.toolchain_lock_sha256);
    expect(loaded.lockText).not.toContain('\r');
  });

  it('uses argument lists only: no step starts a shell', () => {
    for (const s of loaded.recipe.steps) expect(effectiveCommand(s.argv), s.id).not.toMatch(/(^|\/)(ba|da|z|k)?sh$/);
  });

  it('verifies the checkout against the pinned commit and names its licence and trust limits', () => {
    expect(loaded.recipe.steps.some((s) => s.expect_stdout_equals === '${SOURCE_COMMIT}')).toBe(true);
    expect(loaded.recipe.license.spdx).toBe('GPL-3.0-or-later');
    expect(loaded.recipe.trust.authenticity).toMatch(/^not established/);
  });

  it('every step id is unique and phases never go backwards', () => {
    const order = ['toolchain', 'source', 'build', 'verify'];
    const phases = loaded.recipe.steps.map((s) => order.indexOf(s.phase));
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
    expect(new Set(loaded.recipe.steps.map((s) => s.id)).size).toBe(loaded.recipe.steps.length);
  });
});

describe('smoke cases', () => {
  const oracles = JSON.parse(readFileSync(path.join(import.meta.dirname, '../oracles.json'), 'utf8')) as { id: string; expected_probability: number; expected_cut_sets: string[][] }[];
  const sorted = (sets: string[][]): string[][] => sets.map((s) => [...s].sort()).sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));

  it('expected values equal the independent enumeration oracle (not engine output)', () => {
    expect(loaded.smokeCases.length).toBeGreaterThanOrEqual(7);
    for (const c of loaded.smokeCases) {
      const doc = { ...mkDoc(c.top, c.events, c.gates as never) };
      const o = enumerate(doc);
      const want = c.method === 'mcub' ? o.mcub : c.method === 'rare-event' ? o.rareEvent : o.probability;
      expect(Math.abs(want.toNumber() - c.expected_probability), c.id).toBeLessThanOrEqual(1e-12);
      expect(sorted(c.expected_cut_sets), c.id).toEqual(o.cutSets);
    }
  });

  it('values that also appear in the frozen hand oracles agree with them', () => {
    for (const c of loaded.smokeCases) {
      const hand = oracles.find((o) => o.id === c.id);
      if (!hand) continue;
      expect(c.expected_probability, c.id).toBe(hand.expected_probability);
      expect(sorted(c.expected_cut_sets), c.id).toEqual(sorted(hand.expected_cut_sets));
    }
  });

  it('includes the voting shape SCRAM gets wrong, so a build that regresses the export route is caught', () => {
    const c = loaded.smokeCases.find((x) => x.id === 'vote-over-gate-input')!;
    expect(c.gates.some((g) => g.type === 'atleast' && g.inputs.includes('G0'))).toBe(true);
    expect(c.expected_probability).toBe(0.37);
  });
});

describe('the loader refuses unsafe or inconsistent recipes', () => {
  it('structure: wrong schema id or version, missing sections, unknown fields', () => {
    const a = clone();
    (a.schema as { version: number }).version = 2;
    expect(codes(a)).toEqual(['R_SCHEMA']);
    const b = JSON.parse(JSON.stringify(loaded.recipe));
    delete b.steps;
    expect(codes(b)).toEqual(['R_SCHEMA']);
    const c = JSON.parse(JSON.stringify(loaded.recipe));
    c.extra = true;
    expect(codes(c)).toEqual(['R_SCHEMA']);
    expect(codes(null)).toEqual(['R_SCHEMA']);
  });

  it('a commit that is not 40 hex digits', () => {
    const r = clone();
    r.trust.source_commit = '0.16.2';
    expect(codes(r)).toEqual(['R_SCHEMA']);
  });

  const withStep = (argv: string[], extra: Record<string, unknown> = {}): Recipe => {
    const r = clone();
    r.steps.splice(1, 0, { id: 'injected', phase: 'toolchain', argv, timeout_s: 10, ...extra } as never);
    return r;
  };

  it('shells are refused, directly and behind env', () => {
    expect(codes(withStep(['/usr/bin/bash', '-c', 'rm -rf /']))).toEqual(['R_SHELL']);
    expect(codes(withStep(['/usr/bin/env', 'A=1', '/bin/sh', '-c', 'echo']))).toEqual(['R_SHELL']);
    expect(codes(withStep(['/usr/bin/env', '-i', 'A=1', '/usr/bin/dash']))).toEqual(['R_SHELL']);
    expect(effectiveCommand(['/usr/bin/env', 'A=1', '-i', '/usr/bin/cp', 'x'])).toBe('/usr/bin/cp');
  });

  it('unknown placeholders and placeholders nothing defines', () => {
    expect(codes(withStep(['/usr/bin/echo', '${NOPE}']))).toEqual(['R_PLACEHOLDER']);
    // the two rules give different reasons: a name that does not exist, and a real name nothing defines
    const message = (r: unknown): string => checkRecipe(r, loaded.lockText).map((i) => i.message).join(' | ');
    expect(message(withStep(['/usr/bin/echo', '${NOPE}']))).toContain('unknown placeholder ${NOPE}');
    const r = clone();
    r.prerequisites = r.prerequisites.filter((p) => p.var !== 'GIT');
    expect(codes(r)).toEqual(['R_PLACEHOLDER']);
    expect(message(r)).toContain('no prerequisite defines it');
    expect(message(r)).not.toContain('unknown placeholder');
    const noCandidates = clone();
    delete noCandidates.prerequisites.find((p) => p.var === 'CONDA')!.candidates;
    expect(codes(noCandidates)).toEqual(['R_PLACEHOLDER']); // a variable with nothing to resolve it
  });

  it('absolute paths outside the prefix and parent traversal', () => {
    expect(codes(withStep(['/usr/bin/cp', '/etc/passwd', '${PREFIX}/x']))).toEqual(['R_UNSAFE_PATH']);
    expect(codes(withStep(['/usr/bin/cp', '${PREFIX}/../../etc/passwd', '${PREFIX}/x']))).toEqual(['R_UNSAFE_PATH']);
    expect(codes(withStep(['/opt/evil/tool']))).toEqual(['R_UNSAFE_PATH']);
  });

  it('duplicate step ids and phases that go backwards', () => {
    const dup = clone();
    dup.steps[1]!.id = dup.steps[0]!.id;
    expect(codes(dup)).toEqual(['R_STEP_ID']);
    const back = clone();
    back.steps.push({ id: 'late-toolchain', phase: 'toolchain', argv: ['/usr/bin/true'], timeout_s: 5 });
    expect(codes(back)).toEqual(['R_PHASE_ORDER']);
  });

  it('a recipe that never verifies the checkout is refused', () => {
    const r = clone();
    for (const s of r.steps) delete s.expect_stdout_equals;
    expect(codes(r)).toEqual(['R_SOURCE_UNVERIFIED']);
  });

  it('a lock that was edited, lost a hash, or points outside the channel', () => {
    expect(codes(loaded.recipe, loaded.lockText + '# edit\n')).toContain('R_LOCK_HASH');
    const strip = loaded.lockText.replace(/#[0-9a-f]{64}\n/, '\n');
    const sealed = (lock: string): Recipe => {
      const r = clone();
      r.trust.toolchain_lock_sha256 = require_sha(lock);
      return r;
    };
    expect(codes(sealed(strip), strip)).toEqual(['R_LOCK_FORMAT']);
    const wrongHost = loaded.lockText.replace('https://conda.anaconda.org/conda-forge/', 'https://example.org/conda-forge/');
    expect(codes(sealed(wrongHost), wrongHost)).toEqual(['R_LOCK_FORMAT']);
    const notExplicit = loaded.lockText.replace('@EXPLICIT\n', '');
    expect(codes(sealed(notExplicit), notExplicit)).toEqual(['R_LOCK_FORMAT']);
    expect(codes(sealed(''), '')).toEqual(['R_LOCK_FORMAT']);
  });

  it('loadRecipe reports unreadable files and bad smoke data with typed errors', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'sneed-recipe-'));
    try {
      cpSync(dir, tmp, { recursive: true });
      const smoke = path.join(tmp, 'scram-smoke.json');
      const good = readFileSync(smoke, 'utf8');
      writeFileSync(smoke, JSON.stringify({ assumptions: {}, cases: [] }));
      expect(() => loadRecipe(tmp)).toThrow(RecipeError);
      try {
        loadRecipe(tmp);
      } catch (e) {
        expect((e as RecipeError).issues.map((i) => i.code)).toEqual<RecipeErrorCode[]>(['R_SMOKE']);
      }
      writeFileSync(smoke, good);
      rmSync(path.join(tmp, 'scram-toolchain.linux-64.lock'));
      try {
        loadRecipe(tmp);
        throw new Error('should not load');
      } catch (e) {
        expect((e as RecipeError).issues[0]!.code).toBe('R_IO');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
