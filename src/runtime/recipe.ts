import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorObject, Options, ValidateFunction } from 'ajv';

export type RecipeErrorCode =
  | 'R_IO'
  | 'R_SCHEMA'
  | 'R_PLACEHOLDER'
  | 'R_SHELL'
  | 'R_LOCK_HASH'
  | 'R_LOCK_FORMAT'
  | 'R_SOURCE_UNVERIFIED'
  | 'R_STEP_ID'
  | 'R_PHASE_ORDER'
  | 'R_UNSAFE_PATH'
  | 'R_SMOKE';

export interface RecipeIssue {
  code: RecipeErrorCode;
  message: string;
}

export class RecipeError extends Error {
  constructor(readonly issues: RecipeIssue[]) {
    super(issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  }
}

export type Phase = 'toolchain' | 'source' | 'build' | 'verify';

export interface RecipeStep {
  id: string;
  phase: Phase;
  argv: string[];
  env?: Record<string, string>;
  timeout_s: number;
  expect_stdout_equals?: string;
  expect_stdout_regex?: string;
}

export interface Prerequisite {
  id: string;
  label: string;
  fix: string;
  var?: 'CONDA' | 'GIT';
  candidates?: string[];
  probe_args?: string[];
  windows_probe?: string[];
}

export interface Recipe {
  schema: { id: string; version: number };
  artifact: { id: string; version: string; recipe_revision: number; description: string };
  platform: { os: string; arch: string; host: string };
  compatibility: { app: string; native_model_schema: number; exporter: string; report_parser: string; engine_version_regex: string };
  capabilities?: string[];
  license: { spdx: string; evidence: string; source_obligations: string };
  trust: {
    source_url: string;
    source_commit: string;
    source_identity: string;
    toolchain_channel: string;
    toolchain_lock: string;
    toolchain_lock_sha256: string;
    authenticity: string;
  };
  sizes: { download_bytes: number; expanded_bytes: number; required_free_bytes: number };
  prerequisites: Prerequisite[];
  steps: RecipeStep[];
  outputs: { binary: string; library_dirs: string[]; version_argv: string[] };
  smoke: { cases_file: string };
}

export interface SmokeCase {
  id: string;
  method: 'exact' | 'rare-event' | 'mcub';
  top: string;
  events: Record<string, number>;
  gates: { id: string; type: 'and' | 'or' | 'atleast'; inputs: string[]; threshold?: number }[];
  expected_probability: number;
  expected_cut_sets: string[][];
  note?: string;
}

export interface LoadedRecipe {
  /** Absolute directory the recipe, lock and smoke cases were read from. */
  dir: string;
  recipe: Recipe;
  /** sha256 of the recipe file's bytes. */
  recipeSha256: string;
  lockText: string;
  lockSha256: string;
  smokeAssumptions: Record<string, unknown>;
  smokeCases: SmokeCase[];
}

/** Placeholders a step may use. CONDA and GIT exist only when a prerequisite declares them. */
export const PLACEHOLDERS = ['PREFIX', 'LOCK', 'JOBS', 'CONDA', 'GIT', 'SOURCE_URL', 'SOURCE_COMMIT'] as const;
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const PHASE_ORDER: Record<Phase, number> = { toolchain: 0, source: 1, build: 2, verify: 3 };
const SYSTEM_TOOL_DIRS = ['/usr/bin/', '/bin/'];
const LOCK_LINE = /^https:\/\/[A-Za-z0-9._\-/]+\.(conda|tar\.bz2)#[0-9a-f]{64}$/;

const schemaPath = fileURLToPath(new URL('../../schema/runtime-recipe.schema.json', import.meta.url));
const ajvModule = createRequire(import.meta.url)('ajv/dist/2020.js') as { default?: new (o: Options) => { compile(s: object): ValidateFunction } } & (new (o: Options) => {
  compile(s: object): ValidateFunction;
});
const AjvCtor = ajvModule.default ?? ajvModule;
const checkSchema: ValidateFunction = new AjvCtor({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

/** The program an argv really runs: skips a leading env and its NAME=value arguments. */
export function effectiveCommand(argv: string[]): string {
  let i = 0;
  if (argv[0] && base(argv[0]) === 'env') {
    i = 1;
    while (i < argv.length && (argv[i]!.includes('=') || argv[i]!.startsWith('-'))) i++;
  }
  return argv[i] ?? '';
}

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!);
}

/** Every structural and cross-field problem, not only the first. */
export function checkRecipe(json: unknown, lockText: string): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  if (!checkSchema(json)) {
    for (const e of (checkSchema.errors ?? []) as ErrorObject[]) {
      issues.push({ code: 'R_SCHEMA', message: `${e.instancePath || '/'} ${e.message ?? 'invalid'}` });
    }
    return issues; // later checks assume the structure
  }
  const r = json as unknown as Recipe;

  // lock integrity and format
  if (sha256(lockText) !== r.trust.toolchain_lock_sha256) issues.push({ code: 'R_LOCK_HASH', message: 'the toolchain lock does not match toolchain_lock_sha256' });
  const lockLines = lockText.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
  if (lockLines[0] !== '@EXPLICIT') issues.push({ code: 'R_LOCK_FORMAT', message: 'the toolchain lock must be a conda explicit file starting with @EXPLICIT' });
  const entries = lockLines.slice(1);
  if (entries.length === 0) issues.push({ code: 'R_LOCK_FORMAT', message: 'the toolchain lock lists no packages' });
  for (const l of entries) {
    if (!LOCK_LINE.test(l)) issues.push({ code: 'R_LOCK_FORMAT', message: `lock entry without a sha256: ${l.slice(0, 80)}` });
    else if (!l.startsWith(r.trust.toolchain_channel + '/')) issues.push({ code: 'R_LOCK_FORMAT', message: `lock entry outside the declared channel: ${l.slice(0, 80)}` });
  }

  // steps
  const ids = new Set<string>();
  let lastPhase = -1;
  const defined = new Set<string>(['PREFIX', 'LOCK', 'JOBS', 'SOURCE_URL', 'SOURCE_COMMIT']);
  for (const p of r.prerequisites) if (p.var) defined.add(p.var);
  for (const s of r.steps) {
    if (ids.has(s.id)) issues.push({ code: 'R_STEP_ID', message: `duplicate step id ${s.id}` });
    ids.add(s.id);
    if (PHASE_ORDER[s.phase] < lastPhase) issues.push({ code: 'R_PHASE_ORDER', message: `step ${s.id} (${s.phase}) comes after a later phase` });
    lastPhase = Math.max(lastPhase, PHASE_ORDER[s.phase]);

    const cmd = effectiveCommand(s.argv);
    if (SHELLS.has(base(s.argv[0]!)) || SHELLS.has(base(cmd))) issues.push({ code: 'R_SHELL', message: `step ${s.id} starts a shell (${cmd}); steps are argument lists, never shell strings` });

    const texts = [...s.argv, ...Object.values(s.env ?? {}), s.expect_stdout_equals ?? '', s.expect_stdout_regex ?? ''];
    for (const t of texts) {
      for (const name of placeholdersIn(t)) {
        if (!(PLACEHOLDERS as readonly string[]).includes(name)) issues.push({ code: 'R_PLACEHOLDER', message: `step ${s.id} uses unknown placeholder \${${name}}` });
        else if (!defined.has(name)) issues.push({ code: 'R_PLACEHOLDER', message: `step ${s.id} uses \${${name}} but no prerequisite defines it` });
      }
    }
    // paths: absolute arguments stay inside the install prefix or name a fixed system tool; no parent traversal
    for (const a of s.argv) {
      if (a.split('/').includes('..')) issues.push({ code: 'R_UNSAFE_PATH', message: `step ${s.id} has a parent-directory segment in ${a}` });
      if (a.startsWith('/') && !SYSTEM_TOOL_DIRS.some((d) => a.startsWith(d))) issues.push({ code: 'R_UNSAFE_PATH', message: `step ${s.id} names an absolute path outside the install prefix: ${a}` });
    }
  }

  // the checkout must be verified against the pinned commit
  if (!r.steps.some((s) => s.expect_stdout_equals === '${SOURCE_COMMIT}')) {
    issues.push({ code: 'R_SOURCE_UNVERIFIED', message: 'no step verifies the checked-out commit against ${SOURCE_COMMIT}' });
  }
  // every placeholder-using prerequisite var must have candidates
  for (const p of r.prerequisites) if (p.var && !p.candidates?.length) issues.push({ code: 'R_PLACEHOLDER', message: `prerequisite ${p.id} defines ${p.var} without candidates` });
  return issues;
}

/** Loads and fully checks a recipe from a directory (recipe, lock and smoke cases sit next to each other). */
export function loadRecipe(dir: string, file = 'scram.recipe.json'): LoadedRecipe {
  const read = (name: string): string => {
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch (e) {
      throw new RecipeError([{ code: 'R_IO', message: `cannot read ${name}: ${(e as Error).message}` }]);
    }
  };
  const raw = read(file);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new RecipeError([{ code: 'R_SCHEMA', message: `not valid JSON: ${(e as Error).message}` }]);
  }
  const lockName = (json as { trust?: { toolchain_lock?: string } })?.trust?.toolchain_lock;
  const lockText = typeof lockName === 'string' && /^[A-Za-z0-9._-]+$/.test(lockName) ? read(lockName) : '';
  const issues = checkRecipe(json, lockText);
  if (issues.length) throw new RecipeError(issues);
  const recipe = json as Recipe;

  const smokeRaw = JSON.parse(read(recipe.smoke.cases_file)) as { assumptions?: Record<string, unknown>; cases?: SmokeCase[] };
  const smokeIssues: RecipeIssue[] = [];
  if (!smokeRaw.assumptions || !Array.isArray(smokeRaw.cases) || smokeRaw.cases.length === 0) smokeIssues.push({ code: 'R_SMOKE', message: 'the smoke file needs assumptions and at least one case' });
  const seen = new Set<string>();
  for (const c of smokeRaw.cases ?? []) {
    if (seen.has(c.id)) smokeIssues.push({ code: 'R_SMOKE', message: `duplicate smoke case ${c.id}` });
    seen.add(c.id);
    if (!(c.expected_probability >= 0 && c.expected_probability <= 1) || !Array.isArray(c.expected_cut_sets)) smokeIssues.push({ code: 'R_SMOKE', message: `smoke case ${c.id} has no usable expected values` });
  }
  if (smokeIssues.length) throw new RecipeError(smokeIssues);

  return { dir: path.resolve(dir), recipe, recipeSha256: sha256(raw), lockText, lockSha256: sha256(lockText), smokeAssumptions: smokeRaw.assumptions!, smokeCases: smokeRaw.cases! };
}
