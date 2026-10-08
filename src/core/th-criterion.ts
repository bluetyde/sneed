// Stage T0 of the thermal-hydraulic link (docs/plans/14-th-link.md): a success criterion for one heading of an event tree, the record of what
// one run showed (entered by hand in this stage), and the rule that joins them. Only a pass/fail FACT ABOUT ONE RUN crosses from a
// thermal-hydraulic run to a tree: never a probability, never failure logic. The tree keeps every number.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { ValidateFunction, Options } from 'ajv';
import { canon } from './canonical.js';

interface AjvLike {
  compile(schema: object): ValidateFunction;
}
const ajvModule = createRequire(import.meta.url)('ajv/dist/2020.js') as { default?: new (o: Options) => AjvLike } & (new (o: Options) => AjvLike);
const AjvCtor = ajvModule.default ?? ajvModule;
const ajv = new AjvCtor({ allErrors: true, strict: true });
const load = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../schema/${name}`, import.meta.url)), 'utf8'));
const checkCriterionSchema: ValidateFunction = ajv.compile(load('th-criterion.schema.json') as object);
const checkAnswerSchema: ValidateFunction = ajv.compile(load('th-answer.schema.json') as object);

export type ThErrorCode =
  | 'E_SCHEMA'
  | 'E_WINDOW_ORDER'
  | 'E_OBSERVED_ORDER'
  | 'E_NO_OBSERVED'
  | 'E_NO_TREE'
  | 'E_STALE_TREE'
  | 'E_UNKNOWN_HEADING';
export interface ThIssue {
  code: ThErrorCode;
  /** JSON Pointer into the document. */
  path: string;
  /** Plain text. Names and ids are quoted with JSON.stringify, never interpreted. */
  message: string;
}
export interface ThValidation {
  valid: boolean;
  errors: ThIssue[];
}

/** What the criterion check needs to know about the event tree it names. */
export interface TreeRef {
  hash: string;
  headings: ReadonlySet<string>;
}
export interface ThContext {
  /** Looks an event tree up by its saved name: null when there is none (or it is not a valid tree). Without it only the document itself is checked. */
  resolveTree?: (name: string) => TreeRef | null;
}

export interface ThWindow {
  from: number;
  to: number;
  unit: 's';
}
export interface ThCriterion {
  schema: { id: 'sneed.th-criterion'; version: 1 };
  criterion: { id: string; name: string; description: string; synthetic: boolean; created: string; updated: string };
  applies_to: { event_tree: { name: string; tree_hash: string }; heading: string };
  plant: { model_name: string; model_hash: string; mutation_list_hash: string | null };
  condition: { quantity: string; comparison: 'above' | 'at-least' | 'below' | 'at-most'; limit: number; unit: string; window: ThWindow; holds: 'throughout' | 'at-some-time' };
}
export interface ThAnswer {
  schema: { id: 'sneed.th-answer'; version: 1 };
  answer: { id: string; entered_by: 'hand'; entered: string; note: string };
  criterion_hash: string;
  plant: { model_hash: string; mutation_list_hash: string | null };
  engine: { name: string; version: string; build: string };
  run: { status: 'completed' | 'failed' | 'truncated' | 'terminated-by-trip' };
  observed: { quantity: string; unit: string; window: ThWindow; min: number; max: number } | null;
}

const q = (s: unknown): string => JSON.stringify(s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (code: ThErrorCode, path: string, message: string): ThIssue => ({ code, path, message });

function schemaIssues(check: ValidateFunction): ThIssue[] {
  return (check.errors ?? []).map((e) => {
    const missing = e.keyword === 'required' ? String((e.params as { missingProperty: string }).missingProperty) : undefined;
    return err('E_SCHEMA', missing ? `${e.instancePath}/${missing}` : e.instancePath || '/', missing ? `missing required field "${missing}"` : `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  });
}

const dedupe = (list: ThIssue[]): ThIssue[] => {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = `${i.code}|${i.path}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// ---------------------------------------------------------------- the criterion

export function validateCriterion(doc: unknown, ctx: ThContext = {}): ThValidation {
  if (!isObj(doc)) return { valid: false, errors: [err('E_SCHEMA', '/', 'the document must be a JSON object')] };
  if (!checkCriterionSchema(doc)) return { valid: false, errors: dedupe(schemaIssues(checkCriterionSchema)) };
  const d = doc as unknown as ThCriterion;
  const errors: ThIssue[] = [];
  // JSON text such as 1e999 reads as infinity, which the schema's "number" refuses, so every number seen here is finite
  if (!(d.condition.window.to > d.condition.window.from)) {
    errors.push(err('E_WINDOW_ORDER', '/condition/window/to', 'the window must end after it starts'));
  }
  if (ctx.resolveTree) {
    const ref = d.applies_to.event_tree;
    const tree = ctx.resolveTree(ref.name);
    if (!tree) errors.push(err('E_NO_TREE', '/applies_to/event_tree/name', `there is no valid event tree called ${q(ref.name)}`));
    else {
      if (tree.hash !== ref.tree_hash) errors.push(err('E_STALE_TREE', '/applies_to/event_tree/tree_hash', `the event tree ${q(ref.name)} has changed since this criterion was written (the saved hash differs): the heading may no longer mean the same thing`));
      if (!tree.headings.has(d.applies_to.heading)) errors.push(err('E_UNKNOWN_HEADING', '/applies_to/heading', `the event tree ${q(ref.name)} has no heading ${q(d.applies_to.heading)}`));
    }
  }
  const e2 = dedupe(errors);
  return { valid: e2.length === 0, errors: e2 };
}

/** Validate document text exactly as saved. Invalid JSON is E_SCHEMA. */
export function validateCriterionText(text: string, ctx: ThContext = {}): ThValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { valid: false, errors: [err('E_SCHEMA', '/', `not valid JSON: ${(e as Error).message}`)] };
  }
  return validateCriterion(doc, ctx);
}

/**
 * Hash of what the criterion MEANS: the tree and heading it is about, the plant model and change list it is run against, and the condition.
 * Name, description, the example label and the time stamps are not part of it. Callers validate first.
 */
export function criterionHash(d: ThCriterion): string {
  const c = d.condition;
  const projection = {
    schema: { id: d.schema.id, version: d.schema.version },
    applies_to: { event_tree: { name: d.applies_to.event_tree.name, tree_hash: d.applies_to.event_tree.tree_hash }, heading: d.applies_to.heading },
    plant: { model_name: d.plant.model_name, model_hash: d.plant.model_hash, mutation_list_hash: d.plant.mutation_list_hash },
    condition: { quantity: c.quantity, comparison: c.comparison, limit: c.limit, unit: c.unit, window: { from: c.window.from, to: c.window.to, unit: c.window.unit }, holds: c.holds },
  };
  return createHash('sha256').update(canon(projection), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- the answer

export function validateAnswer(doc: unknown): ThValidation {
  if (!isObj(doc)) return { valid: false, errors: [err('E_SCHEMA', '/', 'the document must be a JSON object')] };
  if (!checkAnswerSchema(doc)) return { valid: false, errors: dedupe(schemaIssues(checkAnswerSchema)) };
  const d = doc as unknown as ThAnswer;
  const errors: ThIssue[] = [];
  const o = d.observed;
  if (o === null) {
    if (d.run.status === 'completed') errors.push(err('E_NO_OBSERVED', '/observed', 'a completed run must say what it observed'));
  } else {
    if (o.min > o.max) errors.push(err('E_OBSERVED_ORDER', '/observed/min', 'the smallest value seen is larger than the largest'));
    if (!(o.window.to > o.window.from)) errors.push(err('E_WINDOW_ORDER', '/observed/window/to', 'the window must end after it starts'));
  }
  const e2 = dedupe(errors);
  return { valid: e2.length === 0, errors: e2 };
}

/** Validate answer text exactly as saved. Invalid JSON is E_SCHEMA. */
export function validateAnswerText(text: string): ThValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { valid: false, errors: [err('E_SCHEMA', '/', `not valid JSON: ${(e as Error).message}`)] };
  }
  return validateAnswer(doc);
}

// ---------------------------------------------------------------- the judgement

export type ThStatus = 'held' | 'did-not-hold' | 'stale' | 'not-determined';
export type ThReason =
  | 'criterion-invalid'
  | 'answer-invalid'
  | 'tree-changed'
  | 'plant-changed'
  | 'engine-changed'
  | 'mutations-changed'
  | 'criterion-changed'
  | 'heading-unknown'
  | 'mutation-link-invalid'
  | 'run-failed'
  | 'run-truncated'
  | 'run-terminated-by-trip'
  | 'quantity-differs'
  | 'unit-differs'
  | 'window-differs';

/** What exists NOW, supplied by the caller: identities and the headings of the tree. */
export interface ThCurrent {
  treeHash: string;
  plantModelHash: string;
  mutationListHash: string | null;
  /** The engine and build that would run it now; an answer made by another one is stale (a changed solver can change the numbers). */
  engine: { name: string; version: string; build: string };
  /** The headings of the event tree as it is now. */
  treeHeadings: ReadonlySet<string>;
}
export interface ThJudgement {
  status: ThStatus;
  reasons: ThReason[];
  /** The words to show. Always says what the answer is a fact about, and that it is not a probability. */
  text: string;
}

/** The words shown for a status: what it says, and that it is a fact about one run and not a probability. */
export const describeStatus = (status: ThStatus): string => `${STATUS_TEXT[status]} ${TH_NOTE}`;

export const TH_NOTE =
  'This is a fact about one run, made with the stated plant model and changes. It is not a probability: the failure probability of the heading still comes from its fault tree.';

const STATUS_TEXT: Record<ThStatus, string> = {
  held: 'HELD in this run: the condition was met.',
  'did-not-hold': 'DID NOT HOLD in this run: the condition was not met.',
  stale: 'STALE: this answer was made from something that has since changed. Run it again; it does not count.',
  'not-determined': 'NOT DETERMINED: the run does not settle the condition.',
};

function stale(c: ThCriterion, a: ThAnswer, cur: ThCurrent): ThReason[] {
  const r: ThReason[] = [];
  if (c.applies_to.event_tree.tree_hash !== cur.treeHash) r.push('tree-changed');
  // the criterion pins the plant and the changes; both the criterion and the answer must agree with what exists now
  if (c.plant.model_hash !== cur.plantModelHash || a.plant.model_hash !== c.plant.model_hash) r.push('plant-changed');
  if (c.plant.mutation_list_hash !== cur.mutationListHash || a.plant.mutation_list_hash !== c.plant.mutation_list_hash) r.push('mutations-changed');
  if (a.criterion_hash !== criterionHash(c)) r.push('criterion-changed');
  if (a.engine.name !== cur.engine.name || a.engine.version !== cur.engine.version || a.engine.build !== cur.engine.build) r.push('engine-changed');
  return r;
}

function undetermined(c: ThCriterion, a: ThAnswer, cur: ThCurrent): ThReason[] {
  const r: ThReason[] = [];
  // the criterion names a heading the tree does not have: nothing it says can be applied to the tree
  if (!cur.treeHeadings.has(c.applies_to.heading)) r.push('heading-unknown');
  if (a.run.status === 'failed') r.push('run-failed');
  else if (a.run.status === 'truncated') r.push('run-truncated');
  else if (a.run.status === 'terminated-by-trip') r.push('run-terminated-by-trip');
  const o = a.observed;
  if (o === null) return r;
  if (o.quantity !== c.condition.quantity) r.push('quantity-differs');
  if (o.unit !== c.condition.unit) r.push('unit-differs');
  // exactly the window asked for: a longer window would mix in values the criterion does not ask about
  if (o.window.from !== c.condition.window.from || o.window.to !== c.condition.window.to) r.push('window-differs');
  return r;
}

function holds(c: ThCriterion, o: NonNullable<ThAnswer['observed']>): boolean {
  const k = c.condition;
  // "throughout" needs the worst value in the direction of the limit to satisfy it; "at some time" needs the best value to
  const lower = k.comparison === 'above' || k.comparison === 'at-least';
  const value = lower ? (k.holds === 'throughout' ? o.min : o.max) : k.holds === 'throughout' ? o.max : o.min;
  switch (k.comparison) {
    case 'above':
      return value > k.limit;
    case 'at-least':
      return value >= k.limit;
    case 'below':
      return value < k.limit;
    default:
      return value <= k.limit;
  }
}

/**
 * Decide what one recorded run says about a criterion. Order: an invalid input settles nothing; a stale answer is not read (it is to be run
 * again); a run that does not settle the condition is not guessed at; only then is the condition tested. The test never leans on anything but
 * the numbers in the record.
 */
export function judge(criterion: unknown, answer: unknown, cur: ThCurrent): ThJudgement {
  const make = (status: ThStatus, reasons: ThReason[]): ThJudgement => ({ status, reasons, text: describeStatus(status) });
  const cv = validateCriterion(criterion);
  const av = validateAnswer(answer);
  if (!cv.valid || !av.valid) return make('not-determined', [...(cv.valid ? [] : (['criterion-invalid'] as const)), ...(av.valid ? [] : (['answer-invalid'] as const))]);
  const c = criterion as ThCriterion;
  const a = answer as ThAnswer;
  const s = stale(c, a, cur);
  if (s.length) return make('stale', s);
  const u = undetermined(c, a, cur);
  if (u.length) return make('not-determined', u);
  return make(holds(c, a.observed!) ? 'held' : 'did-not-hold', []);
}

// ---------------------------------------------------------------- finding the criterion of a heading

export type ThFound =
  | { ok: true; criterion: ThCriterion }
  | { ok: false; code: 'E_TH_NO_CRITERION' | 'E_TH_AMBIGUOUS'; message: string };

/**
 * The one criterion that is about this heading of this tree. A heading with none is refused (never given a default), and so is one with
 * two: the tool does not pick between them. A criterion that is not valid is not counted, and the refusal says how many were skipped.
 */
export function criterionForHeading(criteria: readonly unknown[], treeName: string, headingId: string): ThFound {
  const valid: ThCriterion[] = [];
  let skipped = 0;
  for (const raw of criteria) {
    if (!validateCriterion(raw).valid) {
      skipped++;
      continue;
    }
    const c = raw as ThCriterion;
    if (c.applies_to.event_tree.name === treeName && c.applies_to.heading === headingId) valid.push(c);
  }
  const where = `the heading ${q(headingId)} of the event tree ${q(treeName)}`;
  const skip = skipped ? ` (${skipped} criterion document${skipped === 1 ? ' was' : 's were'} not valid and not counted)` : '';
  if (valid.length === 0) return { ok: false, code: 'E_TH_NO_CRITERION', message: `there is no success criterion for ${where}${skip}: without one no run can say whether this heading works` };
  if (valid.length > 1) return { ok: false, code: 'E_TH_AMBIGUOUS', message: `there are ${valid.length} success criteria for ${where}: keep one` };
  return { ok: true, criterion: valid[0]! };
}
