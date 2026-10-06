// The event-tree document (docs/plans/13-event-trees.md, stage S1): its structure, its references to a fault-tree model, the paths its
// headings allow, and the rules that make its sequences a complete, non-overlapping list. No computation happens here: the numbers
// (sequence frequencies) are stage S2. A document that passes is one whose sequences PARTITION the possible outcomes, which is what the
// engine will rely on.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { ErrorObject, ValidateFunction, Options } from 'ajv';
import { canon } from './canonical.js';

interface AjvLike {
  compile(schema: object): ValidateFunction;
}
const ajvModule = createRequire(import.meta.url)('ajv/dist/2020.js') as { default?: new (o: Options) => AjvLike } & (new (o: Options) => AjvLike);
const AjvCtor = ajvModule.default ?? ajvModule;

export const MAX_HEADINGS = 12;
export const MAX_SEQUENCES = 4096;

export type Branch = 'works' | 'fails';
export interface PathStep {
  heading: string;
  branch: Branch;
}

export type EtErrorCode =
  | 'E_SCHEMA'
  | 'E_NO_FREQUENCY'
  | 'E_NO_UNIT'
  | 'E_FREQUENCY_RANGE'
  | 'E_NO_MODEL'
  | 'E_MODEL_NOT_FOUND'
  | 'E_STALE_MODEL'
  | 'E_UNKNOWN_EVENT'
  | 'E_ID_FORMAT'
  | 'E_DUP_HEADING'
  | 'E_DUP_ID'
  | 'E_TOO_MANY_HEADINGS'
  | 'E_BYPASS_ORDER'
  | 'E_PATH_INCOMPLETE'
  | 'E_SEQUENCE_DUP'
  | 'E_SEQUENCES_MISSING'
  | 'E_NO_END_STATE'
  | 'E_END_STATE_UNKNOWN';
export type EtWarningCode = 'W_UNUSED_END_STATE' | 'W_ZERO_FREQUENCY' | 'W_UNKNOWN_FIELD';
export type EtCode = EtErrorCode | EtWarningCode;

export interface EtIssue {
  code: EtCode;
  severity: 'error' | 'warning';
  /** JSON Pointer into the document. */
  path: string;
  /** Plain text. Names and ids are quoted with JSON.stringify, never interpreted. */
  message: string;
  /** Heading or end-state ids the issue refers to. */
  ids?: string[];
}

export interface EtValidation {
  valid: boolean;
  errors: EtIssue[];
  warnings: EtIssue[];
  /** Whether the fault-tree model was looked at (a resolver was given). Without it only the document itself is checked. */
  modelChecked: boolean;
}

/** What the validator needs to know about the referenced fault-tree model. */
export interface ModelRef {
  hash: string;
  events: ReadonlySet<string>;
  gates: ReadonlySet<string>;
}
export interface EtContext {
  /** Looks a fault-tree model up by its saved name: null when there is none (or it is not a valid model). */
  resolveModel?: (name: string) => ModelRef | null;
}

const schema: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('../../schema/event-tree.schema.json', import.meta.url)), 'utf8'));
const checkSchema: ValidateFunction = new AjvCtor({ allErrors: true, strict: true }).compile(schema as object);

const q = (s: unknown): string => JSON.stringify(s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function issue(code: EtCode, path: string, message: string, ids?: string[]): EtIssue {
  const i: EtIssue = { code, severity: code.startsWith('E_') ? 'error' : 'warning', path, message };
  if (ids && ids.length) i.ids = ids;
  return i;
}

// ---------------------------------------------------------------- paths

interface HeadingLike {
  id: string;
  asked_only_if?: { heading: string; branch: Branch };
}

/**
 * Every complete path through the headings, in heading order. A heading is asked on a path unless it has a condition and the heading the
 * condition names was not asked there or took the other branch (so a heading that depends on a heading that was itself not asked is not
 * asked either). A condition that names an unknown or later heading is never satisfied (the validator reports it separately).
 */
export function enumeratePaths(headings: HeadingLike[]): PathStep[][] {
  const out: PathStep[][] = [];
  if (headings.length > MAX_HEADINGS) return out;
  const walk = (i: number, path: PathStep[]): void => {
    if (out.length > MAX_SEQUENCES) return;
    if (i === headings.length) {
      out.push(path);
      return;
    }
    const h = headings[i]!;
    let asked = true;
    if (h.asked_only_if) {
      const earlier = path.find((s) => s.heading === h.asked_only_if!.heading);
      asked = earlier !== undefined && earlier.branch === h.asked_only_if.branch;
    }
    if (!asked) return walk(i + 1, path);
    walk(i + 1, [...path, { heading: h.id, branch: 'works' }]);
    walk(i + 1, [...path, { heading: h.id, branch: 'fails' }]);
  };
  walk(0, []);
  return out;
}

/** One string per path, for comparing and sorting: "A:works,B:fails". */
export const pathKey = (p: PathStep[]): string => p.map((s) => `${s.heading}:${s.branch}`).join(',');

/** The sequences the headings allow, each with the given end state (empty by default: the author must choose). */
export function skeletonSequences(headings: HeadingLike[], endState = ''): { path: PathStep[]; end_state: string }[] {
  return enumeratePaths(headings).map((path) => ({ path, end_state: endState }));
}

// ---------------------------------------------------------------- schema errors to codes

function mapAjvError(e: ErrorObject): EtIssue | null {
  if (e.keyword === 'if') return null;
  const path = e.instancePath;
  const detail = e.message ?? 'invalid';
  const missing = e.keyword === 'required' ? String((e.params as { missingProperty: string }).missingProperty) : undefined;
  if (path === '/initiating_event' && missing === 'frequency') return issue('E_NO_FREQUENCY', '/initiating_event/frequency', 'the initiating event has no frequency: without one no sequence has a frequency');
  if (path === '/initiating_event' && missing === 'unit') return issue('E_NO_UNIT', '/initiating_event/unit', 'the initiating event has no unit for its frequency');
  if (path === '/initiating_event/frequency') return issue('E_FREQUENCY_RANGE', path, `the frequency ${detail} (it must be a finite number, 0 or more)`);
  if (path === '/initiating_event/unit') return issue('E_NO_UNIT', path, 'the frequency unit must be "per-year" (the only unit this version knows)');
  if (path === '' && missing === 'fault_tree_model') return issue('E_NO_MODEL', '/fault_tree_model', 'the document names no fault-tree model for its headings');
  if (path === '/fault_tree_model' && missing) return issue('E_NO_MODEL', `/fault_tree_model/${missing}`, `the fault-tree model reference has no ${q(missing)}`);
  if (path === '/headings' && e.keyword === 'maxItems') return issue('E_TOO_MANY_HEADINGS', path, `an event tree has at most ${MAX_HEADINGS} headings in this version`);
  if (/^\/(headings|end_states)\/\d+\/id$/.test(path) && e.keyword === 'pattern') return issue('E_ID_FORMAT', path, 'the id does not match the identifier pattern (1 to 64 letters, digits, underscores and inner dashes)');
  const where = missing ? `${path}/${missing}` : path;
  return issue('E_SCHEMA', where || '/', missing ? `missing required field "${missing}"` : `${path || '/'} ${detail}`);
}

// ---------------------------------------------------------------- the semantic rules

const KNOWN_TOP = ['schema', 'tree', 'fault_tree_model', 'initiating_event', 'headings', 'end_states', 'sequences', 'assumptions'];

function semantic(doc: Record<string, unknown>, ctx: EtContext, errors: EtIssue[], warnings: EtIssue[]): boolean {
  const headings = doc.headings as { id: string; event: string; asked_only_if?: { heading: string; branch: Branch } }[];
  const endStates = doc.end_states as { id: string }[];
  const sequences = doc.sequences as { path: PathStep[]; end_state: string }[];
  const ie = doc.initiating_event as { frequency: number };
  const ref = doc.fault_tree_model as { name: string; model_hash: string };

  if (ie.frequency === 0) warnings.push(issue('W_ZERO_FREQUENCY', '/initiating_event/frequency', 'the frequency is 0, so every sequence frequency will be 0'));

  // ids
  const headingIndex = new Map<string, number>();
  headings.forEach((h, i) => {
    if (headingIndex.has(h.id)) errors.push(issue('E_DUP_HEADING', `/headings/${i}/id`, `the heading id ${q(h.id)} is used twice`, [h.id]));
    else headingIndex.set(h.id, i);
  });
  const endIds = new Set<string>();
  endStates.forEach((e, i) => {
    if (endIds.has(e.id)) errors.push(issue('E_DUP_ID', `/end_states/${i}/id`, `the end state id ${q(e.id)} is used twice`, [e.id]));
    else endIds.add(e.id);
  });

  // conditions
  let conditionsOk = true;
  headings.forEach((h, i) => {
    const c = h.asked_only_if;
    if (!c) return;
    const at = headingIndex.get(c.heading);
    if (at === undefined || at >= i) {
      conditionsOk = false;
      errors.push(issue('E_BYPASS_ORDER', `/headings/${i}/asked_only_if/heading`, at === undefined ? `${q(h.id)} is asked only if ${q(c.heading)}, which is not a heading` : `${q(h.id)} is asked only if ${q(c.heading)}, which does not come before it`, [h.id]));
    }
  });

  // the fault-tree model
  let modelChecked = false;
  if (ctx.resolveModel) {
    modelChecked = true;
    const m = ctx.resolveModel(ref.name);
    if (!m) errors.push(issue('E_MODEL_NOT_FOUND', '/fault_tree_model/name', `there is no valid fault-tree model called ${q(ref.name)}`));
    else {
      if (m.hash !== ref.model_hash) errors.push(issue('E_STALE_MODEL', '/fault_tree_model/model_hash', `the model ${q(ref.name)} has changed since this event tree was last checked against it (the saved hash differs): its results would describe another model`));
      headings.forEach((h, i) => {
        if (!m.events.has(h.event) && !m.gates.has(h.event)) errors.push(issue('E_UNKNOWN_EVENT', `/headings/${i}/event`, `the heading ${q(h.id)} names ${q(h.event)}, which is not an event or gate of the model ${q(ref.name)}`, [h.id]));
      });
    }
  }

  // sequences: complete, once each, in order
  const headingsUsable = headings.length <= MAX_HEADINGS && conditionsOk && headingIndex.size === headings.length;
  if (headingsUsable) {
    const complete = enumeratePaths(headings);
    const allowed = new Set(complete.map(pathKey));
    const seen = new Map<string, number>();
    sequences.forEach((s, i) => {
      const where = `/sequences/${i}/path`;
      const key = pathKey(s.path);
      const unknown = s.path.find((st) => !headingIndex.has(st.heading));
      if (unknown) {
        errors.push(issue('E_PATH_INCOMPLETE', where, `the path names ${q(unknown.heading)}, which is not a heading`, [unknown.heading]));
      } else if (!allowed.has(key)) {
        const idx = s.path.map((st) => headingIndex.get(st.heading)!);
        const ordered = idx.every((v, k) => k === 0 || v > idx[k - 1]!);
        const reason = !ordered ? 'its steps are not in the order of the headings' : 'it lists a heading that is not asked on this path, or leaves out one that is (check the "asked only if" rules)';
        errors.push(issue('E_PATH_INCOMPLETE', where, `the path ${q(key)} is not one of the paths the headings allow: ${reason}`));
      } else if (seen.has(key)) {
        errors.push(issue('E_SEQUENCE_DUP', where, `the path ${q(key)} is listed twice (first at sequence ${seen.get(key)! + 1})`));
      } else seen.set(key, i);
    });
    const missing = complete.map(pathKey).filter((k) => !seen.has(k));
    if (missing.length) {
      errors.push(issue('E_SEQUENCES_MISSING', '/sequences', `${missing.length} of the ${complete.length} possible path${complete.length === 1 ? '' : 's'} ${missing.length === 1 ? 'is' : 'are'} not listed (for example ${missing.slice(0, 3).map(q).join(', ')}): the listed sequences would not add up to the whole`));
    }
  }

  // end states
  const used = new Set<string>();
  sequences.forEach((s, i) => {
    if (s.end_state === '') errors.push(issue('E_NO_END_STATE', `/sequences/${i}/end_state`, 'the sequence has no end state: choose the condition it ends in'));
    else if (!endIds.has(s.end_state)) errors.push(issue('E_END_STATE_UNKNOWN', `/sequences/${i}/end_state`, `the end state ${q(s.end_state)} is not defined`, [s.end_state]));
    else used.add(s.end_state);
  });
  endStates.forEach((e, i) => {
    if (!used.has(e.id)) warnings.push(issue('W_UNUSED_END_STATE', `/end_states/${i}`, `no sequence ends in ${q(e.id)}`, [e.id]));
  });

  for (const k of Object.keys(doc)) if (!KNOWN_TOP.includes(k)) warnings.push(issue('W_UNKNOWN_FIELD', `/${k}`, `the field ${q(k)} is not part of this version; it is kept as it is`));
  return modelChecked;
}

export function validateEventTree(doc: unknown, ctx: EtContext = {}): EtValidation {
  const errors: EtIssue[] = [];
  const warnings: EtIssue[] = [];
  if (!isObj(doc)) return { valid: false, errors: [issue('E_SCHEMA', '/', 'the document must be a JSON object')], warnings, modelChecked: false };
  let modelChecked = false;
  if (!checkSchema(doc)) {
    // the rules below read the document's fields: they run only on a document whose structure is sound
    for (const e of checkSchema.errors ?? []) {
      const m = mapAjvError(e);
      if (m) errors.push(m);
    }
  } else modelChecked = semantic(doc, ctx, errors, warnings);
  const seen = new Set<string>();
  const unique = (list: EtIssue[]): EtIssue[] =>
    list.filter((i) => {
      const k = `${i.code}|${i.path}|${i.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const e2 = unique(errors);
  return { valid: e2.length === 0, errors: e2, warnings: unique(warnings), modelChecked };
}

/** Validate document text exactly as saved. Invalid JSON is E_SCHEMA. */
export function validateEventTreeText(text: string, ctx: EtContext = {}): EtValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { valid: false, errors: [issue('E_SCHEMA', '/', `not valid JSON: ${(e as Error).message}`)], warnings: [], modelChecked: false };
  }
  return validateEventTree(doc, ctx);
}

/**
 * Hash of what the document MEANS: the model it refers to, the frequency, the headings in order with their events and conditions, which
 * sequence ends where (sequences in any order), and the assumptions. Names, descriptions, timestamps and the order of the sequence list
 * are not part of it. Callers validate first.
 */
export function eventTreeHash(doc: {
  schema: unknown;
  fault_tree_model: { name: string; model_hash: string };
  initiating_event: { frequency: number; unit: string };
  headings: { id: string; event: string; asked_only_if?: { heading: string; branch: string } }[];
  end_states: { id: string }[];
  sequences: { path: PathStep[]; end_state: string }[];
  assumptions: unknown;
}): string {
  const ends: Record<string, string> = {};
  for (const s of doc.sequences) ends[pathKey(s.path)] = s.end_state;
  const projection = {
    schema: doc.schema,
    fault_tree_model: { name: doc.fault_tree_model.name, model_hash: doc.fault_tree_model.model_hash },
    initiating_event: { frequency: doc.initiating_event.frequency, unit: doc.initiating_event.unit },
    headings: doc.headings.map((h) => ({ id: h.id, event: h.event, ...(h.asked_only_if ? { asked_only_if: { heading: h.asked_only_if.heading, branch: h.asked_only_if.branch } } : {}) })),
    end_states: doc.end_states.map((e) => e.id).sort(),
    sequences: ends,
    assumptions: doc.assumptions,
  };
  return createHash('sha256').update(canon(projection), 'utf8').digest('hex');
}
