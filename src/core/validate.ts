import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction, Options } from 'ajv';

interface AjvLike {
  compile(schema: object): ValidateFunction;
}
// Ajv ships CommonJS; load it through require so the constructor type is explicit under NodeNext.
const ajvModule = createRequire(import.meta.url)('ajv/dist/2020.js') as { default?: new (o: Options) => AjvLike } & (new (o: Options) => AjvLike);
const AjvCtor = ajvModule.default ?? ajvModule;

export type ErrorCode =
  | 'E_SCHEMA'
  | 'E_ID_FORMAT'
  | 'E_DUP_ID'
  | 'E_PROB_RANGE'
  | 'E_NO_TOP'
  | 'E_MISSING_REF'
  | 'E_CYCLE'
  | 'E_GATE_ARITY'
  | 'E_VOTE_RANGE'
  | 'E_VOTE_DUP'
  | 'E_CCF_ASSUMPTION'
  | 'E_CCF_UNKNOWN_MEMBER'
  | 'E_CCF_OVERLAP'
  | 'E_CCF_TOO_SMALL'
  | 'E_CCF_TOO_LARGE'
  | 'E_CCF_BETA_RANGE'
  | 'E_CCF_UNEQUAL_Q'
  | 'E_CCF_NOT_ANALYSED';
export type WarningCode = 'W_UNREACHABLE' | 'W_UNKNOWN_FIELD' | 'W_LAYOUT_STALE';
export type Code = ErrorCode | WarningCode;

export interface Issue {
  code: Code;
  severity: 'error' | 'warning';
  /** JSON Pointer into the document. */
  path: string;
  /** Plain text. IDs are quoted with JSON.stringify, never interpreted. */
  message: string;
  /** Model IDs the issue refers to (for selecting offenders in the editor). */
  ids?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
}

const schemaUrl = new URL('../../schema/model.schema.json', import.meta.url);
const schema: unknown = JSON.parse(readFileSync(fileURLToPath(schemaUrl), 'utf8'));
const ajv = new AjvCtor({ allErrors: true, strict: true });
const checkSchema: ValidateFunction = ajv.compile(schema as object);

const q = (s: unknown): string => JSON.stringify(s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function issue(code: Code, path: string, message: string, ids?: string[]): Issue {
  const i: Issue = { code, severity: code.startsWith('E_') ? 'error' : 'warning', path, message };
  if (ids && ids.length) i.ids = ids;
  return i;
}

/** Map one Ajv error to a stable code (docs/SCHEMA.md). Returns null for wrapper errors. */
function mapAjvError(e: ErrorObject): Issue | null {
  if (e.keyword === 'if') return null; // wrapper that only says a conditional failed
  const path = e.instancePath;
  const detail = e.message ?? 'invalid';
  const missing = e.keyword === 'required' ? String((e.params as { missingProperty: string }).missingProperty) : undefined;
  if (path === '/top' || (path === '' && missing === 'top')) {
    return issue('E_NO_TOP', '/top', missing ? '"top" is missing' : `"top" ${detail}`);
  }
  if (/^\/events\/\d+\/probability$/.test(path)) {
    return issue('E_PROB_RANGE', path, `probability ${detail}`);
  }
  if (/^\/common_cause_groups\/\d+\/beta$/.test(path)) {
    return issue('E_CCF_BETA_RANGE', path, `beta ${detail}`);
  }
  if (/^\/(events|gates|common_cause_groups)\/\d+\/id$/.test(path) && e.keyword === 'pattern') {
    return issue('E_ID_FORMAT', path, `id does not match the identifier pattern`);
  }
  const where = missing ? `${path}/${missing}` : path;
  return issue('E_SCHEMA', where || '/', missing ? `missing required field "${missing}"` : `${path || '/'} ${detail}`);
}

const KNOWN: Record<string, string[]> = {
  '': ['schema', 'model', 'assumptions', 'top', 'events', 'gates', 'common_cause_groups', 'layout'],
  schema: ['id', 'version'],
  model: ['id', 'name', 'created', 'updated'],
  assumptions: ['probability_model', 'independence', 'coherence', 'time'],
  event: ['id', 'name', 'probability', 'source', 'note', 'link'],
  source: ['kind', 'citation'],
  link: ['app', 'component_id', 'revision', 'review'],
  gate: ['id', 'name', 'type', 'inputs', 'threshold'],
  group: ['id', 'name', 'method', 'members', 'beta'],
  layout: ['nodes', 'references'],
  layoutNode: ['id', 'x', 'y'],
  layoutRef: ['node', 'target', 'x', 'y'],
};

function unknownFields(doc: Record<string, unknown>, out: Issue[]): void {
  const scan = (v: unknown, kind: string, path: string): void => {
    if (!isObj(v)) return;
    const known = KNOWN[kind] ?? [];
    for (const k of Object.keys(v)) {
      if (!known.includes(k)) out.push(issue('W_UNKNOWN_FIELD', `${path}/${k}`, `unknown field ${q(k)} is preserved but ignored`));
    }
  };
  scan(doc, '', '');
  for (const k of ['schema', 'model', 'assumptions'] as const) scan(doc[k], k, `/${k}`);
  const eachIn = (arr: unknown, kind: string, base: string, sub?: (item: unknown, p: string) => void): void => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item, i) => {
      scan(item, kind, `${base}/${i}`);
      sub?.(item, `${base}/${i}`);
    });
  };
  eachIn(doc.events, 'event', '/events', (ev, p) => {
    if (isObj(ev)) {
      scan(ev.source, 'source', `${p}/source`);
      scan(ev.link, 'link', `${p}/link`);
    }
  });
  eachIn(doc.gates, 'gate', '/gates');
  eachIn(doc.common_cause_groups, 'group', '/common_cause_groups');
  if (isObj(doc.layout)) {
    scan(doc.layout, 'layout', '/layout');
    eachIn(doc.layout.nodes, 'layoutNode', '/layout/nodes');
    eachIn(doc.layout.references, 'layoutRef', '/layout/references');
  }
}

interface Gate {
  id: string;
  path: string;
  type: unknown;
  inputs: string[];
  threshold: unknown;
}

/** Common-cause groups (plan 15). A group is a visible object: its members are basic events with one shared probability, and the model's assumptions say groups are in use. */
const CCF_MIN = 2;
const CCF_MAX = 8;
function commonCauseChecks(doc: Record<string, unknown>, kinds: Map<string, 'event' | 'gate'>, errors: Issue[]): void {
  const groups = Array.isArray(doc.common_cause_groups) ? doc.common_cause_groups : [];
  const independence = isObj(doc.assumptions) ? doc.assumptions.independence : undefined;
  if (groups.length > 0 && independence !== 'beta-factor-groups') {
    errors.push(issue('E_CCF_ASSUMPTION', '/assumptions/independence', 'the model has common-cause groups, so "independence" must be "beta-factor-groups"'));
  } else if (groups.length === 0 && independence === 'beta-factor-groups') {
    errors.push(issue('E_CCF_ASSUMPTION', '/assumptions/independence', '"independence" is "beta-factor-groups" but the model has no common-cause group'));
  }
  const probability = new Map<string, number>();
  if (Array.isArray(doc.events)) {
    for (const ev of doc.events) if (isObj(ev) && typeof ev.id === 'string' && typeof ev.probability === 'number') probability.set(ev.id, ev.probability);
  }
  const groupIds = new Set<string>();
  const memberOf = new Map<string, string>();
  groups.forEach((g, i) => {
    if (!isObj(g) || typeof g.id !== 'string') return;
    const gid = g.id;
    const path = `/common_cause_groups/${i}`;
    if (groupIds.has(gid) || kinds.has(gid)) {
      errors.push(issue('E_DUP_ID', `${path}/id`, groupIds.has(gid) ? `two groups share the id ${q(gid)}` : `a group and an ${kinds.get(gid)} share the id ${q(gid)}`, [gid]));
    }
    groupIds.add(gid);
    const members = Array.isArray(g.members) ? g.members.filter((m): m is string => typeof m === 'string') : [];
    if (members.length < CCF_MIN) errors.push(issue('E_CCF_TOO_SMALL', `${path}/members`, `group ${q(gid)} has ${members.length} member(s); at least ${CCF_MIN} are required`, [gid]));
    if (members.length > CCF_MAX) errors.push(issue('E_CCF_TOO_LARGE', `${path}/members`, `group ${q(gid)} has ${members.length} members; at most ${CCF_MAX} are allowed`, [gid]));
    const inThis = new Set<string>();
    members.forEach((m, j) => {
      const at = `${path}/members/${j}`;
      if (kinds.get(m) !== 'event') {
        errors.push(issue('E_CCF_UNKNOWN_MEMBER', at, kinds.has(m) ? `member ${q(m)} of group ${q(gid)} is a gate; a member must be a basic event` : `member ${q(m)} of group ${q(gid)} is not an event of the model`, [gid, m]));
        return;
      }
      const other = memberOf.get(m);
      if (inThis.has(m) || other !== undefined) {
        errors.push(issue('E_CCF_OVERLAP', at, inThis.has(m) ? `event ${q(m)} is listed twice in group ${q(gid)}` : `event ${q(m)} is in groups ${q(other)} and ${q(gid)}; an event can be in one group only`, [gid, m]));
        return;
      }
      inThis.add(m);
      memberOf.set(m, gid);
    });
    const known = [...inThis];
    const first = known.length ? probability.get(known[0]!) : undefined;
    if (first !== undefined && known.some((m) => probability.get(m) !== first)) {
      errors.push(issue('E_CCF_UNEQUAL_Q', `${path}/members`, `the members of group ${q(gid)} must have one probability (the beta-factor model has one total probability per group)`, [gid, ...known]));
    }
  });
}

/**
 * The built-in fault-tree analysis expands common-cause groups (plan 15, stage C2). Every other analysis (the SCRAM path, the Open-PSA export,
 * event trees, importance measures) must not run on a model that has them: an engine that ignores a group would give the independent answer
 * without a word. Each of those entry points asks this first.
 */
export function unanalysedGroups(doc: unknown): Issue | null {
  if (!isObj(doc) || !Array.isArray(doc.common_cause_groups) || doc.common_cause_groups.length === 0) return null;
  return issue('E_CCF_NOT_ANALYSED', '/common_cause_groups', 'this model has common-cause groups, and this analysis does not handle them yet (only the built-in fault-tree analysis does); no result is made, so the groups are never silently ignored');
}

function semanticChecks(doc: Record<string, unknown>, errors: Issue[], warnings: Issue[]): void {
  const kinds = new Map<string, 'event' | 'gate'>();
  const gates = new Map<string, Gate>();

  const register = (id: string, kind: 'event' | 'gate', path: string): boolean => {
    const prior = kinds.get(id);
    if (prior) {
      const what = prior === kind ? `two ${kind}s share` : `an event and a gate share`;
      errors.push(issue('E_DUP_ID', `${path}/id`, `${what} the id ${q(id)}`, [id]));
      return false;
    }
    kinds.set(id, kind);
    return true;
  };

  if (Array.isArray(doc.events)) {
    doc.events.forEach((ev, i) => {
      if (isObj(ev) && typeof ev.id === 'string') register(ev.id, 'event', `/events/${i}`);
    });
  }
  const gateList: Gate[] = [];
  if (Array.isArray(doc.gates)) {
    doc.gates.forEach((g, i) => {
      if (!isObj(g) || typeof g.id !== 'string') return;
      const path = `/gates/${i}`;
      const inputs = Array.isArray(g.inputs) ? g.inputs.filter((x): x is string => typeof x === 'string') : [];
      const gate: Gate = { id: g.id, path, type: g.type, inputs, threshold: g.threshold };
      if (register(g.id, 'gate', path)) gates.set(g.id, gate);
      gateList.push(gate);
    });
  }

  // top (the schema reports a missing or non-string top; avoid a duplicate for the same path)
  const topOk = typeof doc.top === 'string' && kinds.has(doc.top);
  if (typeof doc.top === 'string' && !topOk) {
    errors.push(issue('E_NO_TOP', '/top', `top ${q(doc.top)} is not an existing event or gate`, [doc.top]));
  }

  for (const g of gateList) {
    g.inputs.forEach((inp, j) => {
      if (!kinds.has(inp)) errors.push(issue('E_MISSING_REF', `${g.path}/inputs/${j}`, `gate ${q(g.id)} refers to missing id ${q(inp)}`, [g.id, inp]));
    });
    const n = g.inputs.length;
    if (g.type === 'and' || g.type === 'or') {
      if (n < 2) errors.push(issue('E_GATE_ARITY', `${g.path}/inputs`, `${g.type} gate ${q(g.id)} has ${n} input reference(s); at least 2 are required`, [g.id]));
    } else if (g.type === 'atleast') {
      const k = g.threshold;
      if (typeof k !== 'number' || !Number.isInteger(k) || k < 2 || k >= n) {
        errors.push(issue('E_VOTE_RANGE', `${g.path}/threshold`, `atleast gate ${q(g.id)} needs an integer threshold with 2 <= k < ${n} inputs; got ${q(k)}`, [g.id]));
      }
      if (new Set(g.inputs).size !== n) {
        errors.push(issue('E_VOTE_DUP', `${g.path}/inputs`, `atleast gate ${q(g.id)} has a duplicate input`, [g.id]));
      }
    }
  }

  commonCauseChecks(doc, kinds, errors);

  // cycles among gates (iterative three-colour DFS; first definition of an id wins)
  const color = new Map<string, 0 | 1 | 2>();
  const seenCycles = new Set<string>();
  // the gate inputs that are themselves gates, listed once per gate: a gate with thousands of inputs must not be re-filtered for each of them
  const childCache = new Map<string, string[]>();
  for (const start of gates.keys()) {
    if (color.get(start)) continue;
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    const onPath: string[] = [start];
    color.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      let children = childCache.get(top.id);
      if (!children) {
        children = (gates.get(top.id)?.inputs ?? []).filter((c) => gates.has(c));
        childCache.set(top.id, children);
      }
      if (top.next >= children.length) {
        color.set(top.id, 2);
        stack.pop();
        onPath.pop();
        continue;
      }
      const child = children[top.next++]!;
      const c = color.get(child) ?? 0;
      if (c === 1) {
        const cyc = onPath.slice(onPath.indexOf(child));
        const min = cyc.indexOf([...cyc].sort()[0]!);
        const key = [...cyc.slice(min), ...cyc.slice(0, min)].join('>');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          const gate = gates.get(child)!;
          errors.push(issue('E_CYCLE', gate.path, `gate cycle: ${[...cyc, child].map(q).join(' -> ')}`, cyc));
        }
      } else if (c === 0) {
        color.set(child, 1);
        stack.push({ id: child, next: 0 });
        onPath.push(child);
      }
    }
  }

  // unreachable definitions (only meaningful when the top is valid)
  if (topOk) {
    const seen = new Set<string>([doc.top as string]);
    const queue = [doc.top as string];
    while (queue.length) {
      const id = queue.pop()!;
      for (const inp of gates.get(id)?.inputs ?? []) {
        if (kinds.has(inp) && !seen.has(inp)) {
          seen.add(inp);
          queue.push(inp);
        }
      }
    }
    for (const id of kinds.keys()) {
      if (!seen.has(id)) warnings.push(issue('W_UNREACHABLE', '/', `${kinds.get(id)} ${q(id)} is not reachable from the top event; it is kept and not analysed`, [id]));
    }
  }

  // stale layout entries never change a result
  if (isObj(doc.layout)) {
    const nodes = Array.isArray(doc.layout.nodes) ? doc.layout.nodes : [];
    nodes.forEach((n, i) => {
      if (isObj(n) && typeof n.id === 'string' && !kinds.has(n.id)) warnings.push(issue('W_LAYOUT_STALE', `/layout/nodes/${i}/id`, `layout position for missing id ${q(n.id)}`, [n.id]));
    });
    const refs = Array.isArray(doc.layout.references) ? doc.layout.references : [];
    refs.forEach((r, i) => {
      if (isObj(r) && typeof r.target === 'string' && !kinds.has(r.target)) warnings.push(issue('W_LAYOUT_STALE', `/layout/references/${i}/target`, `visual reference to missing id ${q(r.target)}`, [r.target]));
    });
  }
}

/** Validate a parsed native document. Reports every problem found, errors before warnings. */
export function validateModel(doc: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (!isObj(doc)) {
    errors.push(issue('E_SCHEMA', '/', 'the document must be a JSON object'));
    return { valid: false, errors, warnings };
  }
  if (!checkSchema(doc)) {
    for (const e of checkSchema.errors ?? []) {
      const m = mapAjvError(e);
      if (!m) continue;
      // a beta out of range names its group, so the editor can select it (the schema error knows only the position)
      const at = /^\/common_cause_groups\/(\d+)\/beta$/.exec(m.path);
      const listed = (doc as Record<string, unknown>)['common_cause_groups'];
      const entry = at && Array.isArray(listed) ? (listed as unknown[])[Number(at[1])] : undefined;
      const gid = isObj(entry) ? entry.id : undefined;
      if (m.code === 'E_CCF_BETA_RANGE' && typeof gid === 'string') m.ids = [gid];
      errors.push(m);
    }
  }
  semanticChecks(doc, errors, warnings);
  unknownFields(doc, warnings);

  const seen = new Set<string>();
  const unique = (list: Issue[]): Issue[] =>
    list.filter((i) => {
      const k = `${i.code}|${i.path}|${i.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const e2 = unique(errors);
  const w2 = unique(warnings);
  return { valid: e2.length === 0, errors: e2, warnings: w2 };
}

/** Validate document text exactly as saved. Invalid JSON is E_SCHEMA. */
export function validateModelText(text: string): ValidationResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { valid: false, errors: [issue('E_SCHEMA', '/', `not valid JSON: ${(e as Error).message}`)], warnings: [] };
  }
  return validateModel(doc);
}
