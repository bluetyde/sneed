// Stage T1 of the thermal-hydraulic link (docs/plans/14-th-link.md, addendum): a record that a second plant model is the first one with
// named edits, pinned by hash. SNEED applies and runs nothing and checks only the hashes and the record itself: that the edits really
// produce the second model is a human review. A mutation record carries no probability.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { ValidateFunction, Options } from 'ajv';
import { canon } from './canonical.js';
import { describeStatus, judge, type ThCriterion, type ThCurrent, type ThJudgement } from './th-criterion.js';

interface AjvLike {
  compile(schema: object): ValidateFunction;
}
const ajvModule = createRequire(import.meta.url)('ajv/dist/2020.js') as { default?: new (o: Options) => AjvLike } & (new (o: Options) => AjvLike);
const AjvCtor = ajvModule.default ?? ajvModule;
const checkSchema: ValidateFunction = new AjvCtor({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../schema/th-mutation.schema.json', import.meta.url)), 'utf8')) as object,
);

export type MutationErrorCode =
  | 'E_SCHEMA'
  | 'E_EDIT_NOOP'
  | 'E_EDIT_DUP'
  | 'E_MODELS_IDENTICAL'
  | 'E_SAME_MODEL_NAME'
  | 'E_MODEL_NOT_FOUND'
  | 'E_STALE_BASE'
  | 'E_STALE_MUTATED'
  | 'E_LINK_INVALID'
  | 'E_LINK_HASH'
  | 'E_LINK_MODEL';
export interface MutationIssue {
  code: MutationErrorCode;
  /** JSON Pointer into the document. */
  path: string;
  /** Plain text. Names and ids are quoted with JSON.stringify, never interpreted. */
  message: string;
}
export interface MutationValidation {
  valid: boolean;
  errors: MutationIssue[];
}

export type EditValue = number | string | boolean;
export interface MutationEdit {
  component: string;
  field: string;
  from: EditValue;
  to: EditValue;
}
export interface ThMutation {
  schema: { id: 'sneed.th-mutation'; version: 1 };
  mutation: { id: string; name: string; description: string; synthetic: boolean; created: string; updated: string };
  base_model: { name: string; hash: string };
  mutated_model: { name: string; hash: string };
  edits: MutationEdit[];
  applies: 'from-start';
}

/** What the check needs to know about a plant model as it is now: null when there is none. */
export interface MutationContext {
  resolveModel?: (name: string) => { hash: string } | null;
}

const q = (s: unknown): string => JSON.stringify(s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (code: MutationErrorCode, path: string, message: string): MutationIssue => ({ code, path, message });

export function validateMutation(doc: unknown, ctx: MutationContext = {}): MutationValidation {
  if (!isObj(doc)) return { valid: false, errors: [err('E_SCHEMA', '/', 'the document must be a JSON object')] };
  if (!checkSchema(doc)) {
    const errors = (checkSchema.errors ?? []).map((e) => {
      const missing = e.keyword === 'required' ? String((e.params as { missingProperty: string }).missingProperty) : undefined;
      return err('E_SCHEMA', missing ? `${e.instancePath}/${missing}` : e.instancePath || '/', missing ? `missing required field "${missing}"` : `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    });
    return { valid: false, errors: errors.filter((x, i) => errors.findIndex((y) => y.path === x.path && y.message === x.message) === i) };
  }
  const d = doc as unknown as ThMutation;
  const errors: MutationIssue[] = [];
  if (d.base_model.hash === d.mutated_model.hash) errors.push(err('E_MODELS_IDENTICAL', '/mutated_model/hash', 'the mutated model has the same hash as the base model: the edits changed nothing'));
  if (d.base_model.name === d.mutated_model.name) errors.push(err('E_SAME_MODEL_NAME', '/mutated_model/name', `the mutated model has the same name as the base model (${q(d.base_model.name)}): they must be two models`));
  const seen = new Set<string>();
  d.edits.forEach((e, i) => {
    if (e.from === e.to) errors.push(err('E_EDIT_NOOP', `/edits/${i}/to`, `the edit of ${q(e.field)} on ${q(e.component)} sets it to the value it already has`));
    const key = canon([e.component, e.field]);
    if (seen.has(key)) errors.push(err('E_EDIT_DUP', `/edits/${i}`, `the field ${q(e.field)} of ${q(e.component)} is edited twice`));
    seen.add(key);
  });
  if (ctx.resolveModel) {
    const base = ctx.resolveModel(d.base_model.name);
    if (!base) errors.push(err('E_MODEL_NOT_FOUND', '/base_model/name', `there is no plant model called ${q(d.base_model.name)}`));
    else if (base.hash !== d.base_model.hash) errors.push(err('E_STALE_BASE', '/base_model/hash', `the base model ${q(d.base_model.name)} has changed since this record was written (the saved hash differs): the edits may no longer describe the difference`));
    const mut = ctx.resolveModel(d.mutated_model.name);
    if (!mut) errors.push(err('E_MODEL_NOT_FOUND', '/mutated_model/name', `there is no plant model called ${q(d.mutated_model.name)}`));
    else if (mut.hash !== d.mutated_model.hash) errors.push(err('E_STALE_MUTATED', '/mutated_model/hash', `the mutated model ${q(d.mutated_model.name)} has changed since this record was written (the saved hash differs)`));
  }
  return { valid: errors.length === 0, errors };
}

/** Validate record text exactly as saved. Invalid JSON is E_SCHEMA. */
export function validateMutationText(text: string, ctx: MutationContext = {}): MutationValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { valid: false, errors: [err('E_SCHEMA', '/', `not valid JSON: ${(e as Error).message}`)] };
  }
  return validateMutation(doc, ctx);
}

/**
 * Hash of what the record MEANS: the two models, the edits (in any order) and when they apply. Name, description, the example label and the
 * time stamps are not part of it. Callers validate first.
 */
export function mutationHash(d: ThMutation): string {
  const edits = d.edits
    .map((e) => ({ component: e.component, field: e.field, from: e.from, to: e.to }))
    .sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  const projection = {
    schema: { id: d.schema.id, version: d.schema.version },
    base_model: { name: d.base_model.name, hash: d.base_model.hash },
    mutated_model: { name: d.mutated_model.name, hash: d.mutated_model.hash },
    edits,
    applies: d.applies,
  };
  return createHash('sha256').update(canon(projection), 'utf8').digest('hex');
}

/** What `ThCurrent.mutationListHash` holds when a criterion's record is no longer sound: it equals no hash, so everything pinned to the record is stale. */
export const MUTATION_NOT_CURRENT = 'not-current';

/**
 * The hash of the record as it is NOW, for `judge()`: the record's hash when it is valid and both its models are as recorded, otherwise
 * MUTATION_NOT_CURRENT (a criterion or answer that relied on it is then stale, with the reason "mutations-changed").
 */
export function currentMutationHash(mutation: unknown, ctx: Required<MutationContext>): string {
  if (!validateMutation(mutation, ctx).valid) return MUTATION_NOT_CURRENT;
  return mutationHash(mutation as ThMutation);
}

/** Whether a criterion and a mutation record belong together: the criterion runs the mutated model and pins this very record. */
export function checkCriterionMutation(criterion: ThCriterion, mutation: unknown): MutationValidation {
  const v = validateMutation(mutation);
  if (!v.valid) return { valid: false, errors: [err('E_LINK_INVALID', '/', 'the mutation record is not valid, so it cannot be tied to a criterion')] };
  const m = mutation as ThMutation;
  const errors: MutationIssue[] = [];
  if (criterion.plant.mutation_list_hash !== mutationHash(m)) errors.push(err('E_LINK_HASH', '/plant/mutation_list_hash', 'the criterion does not pin this mutation record (its hash differs, or the criterion names none)'));
  if (criterion.plant.model_name !== m.mutated_model.name || criterion.plant.model_hash !== m.mutated_model.hash) {
    errors.push(err('E_LINK_MODEL', '/plant', `the criterion runs ${q(criterion.plant.model_name)}, not the mutated model ${q(m.mutated_model.name)} of this record (name and hash must both match)`));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Decide what one recorded run says about a criterion that may rest on a mutation record. Use THIS, not `judge()`, whenever the criterion
 * names a record or one is supplied: it works out the current hash of the record itself and refuses to read an answer whose criterion
 * does not belong to the record (a criterion that runs the base model while pinning a record of the mutated one cannot count).
 * Order: a stale answer is stale (changed record or model); otherwise a criterion and record that do not belong together settle nothing.
 */
export function judgeWithMutation(criterion: unknown, answer: unknown, cur: Omit<ThCurrent, 'mutationListHash'>, mutation: unknown | null, models: Required<MutationContext>): ThJudgement {
  const listHash = mutation === null || mutation === undefined ? null : currentMutationHash(mutation, models);
  const j = judge(criterion, answer, { ...cur, mutationListHash: listHash });
  if (j.status === 'stale' || j.reasons.includes('criterion-invalid')) return j;
  const c = criterion as ThCriterion;
  const hasRecord = mutation !== null && mutation !== undefined;
  // with no record supplied, a criterion that pins one is already stale above, so what is left here is a criterion that pins none
  if (!hasRecord || checkCriterionMutation(c, mutation).valid) return j;
  const reasons = [...(j.status === 'not-determined' ? j.reasons : []), 'mutation-link-invalid' as const];
  return { status: 'not-determined', reasons, text: describeStatus('not-determined') };
}

