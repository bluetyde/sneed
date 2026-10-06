// Open-PSA MEF XML -> native model, for the documented subset only (docs/OPEN-PSA-SUBSET.md, "Import rules").
//
// The file is untrusted data. It is read by a small strict scanner written for this subset (not a general XML parser):
// no DTD, no entity declarations, no CDATA, no processing instruction other than the XML declaration, only the five predefined
// entities and numeric references, bounded size, depth and counts, and a line and column for every element, so that every refusal
// can say where. Nothing in the file is ever evaluated, followed, fetched or executed.
//
// Anything outside the subset is refused with E_UNSUPPORTED naming the construct and its line. The importer never guesses.
import { createHash } from 'node:crypto';
import type { NativeModel } from './model.js';
import { validateModel } from './validate.js';

export const IMPORTER_VERSION = 'sneed-import-1';
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_ELEMENTS = 100_000;
const MAX_ATTRS = 16;
const MAX_ATTR_VALUE = 1000;
const MAX_NAME = 200;
const MAX_ERRORS = 50;

export type ImportCode =
  | 'E_XML'
  | 'E_IMPORT_LIMIT'
  | 'E_UNSUPPORTED'
  | 'E_ID_FORMAT'
  | 'E_DUP_ID'
  | 'E_PROB_RANGE'
  | 'E_MISSING_REF'
  | 'E_NO_TOP'
  | 'E_CYCLE'
  | 'E_GATE_ARITY'
  | 'E_VOTE_RANGE'
  | 'E_VOTE_DUP'
  | 'E_SCHEMA';

export interface ImportError {
  code: ImportCode;
  /** 1-based line of the construct in the original file (0 when the whole file is meant). */
  line: number;
  column: number;
  message: string;
  /** For E_UNSUPPORTED: the element or attribute that is outside the subset. */
  construct?: string;
}

export interface ImportNote {
  kind: 'generated-gate' | 'pass-through' | 'warning';
  message: string;
  line: number;
}

export type ImportResult =
  | { ok: true; doc: Record<string, unknown>; text: string; notes: ImportNote[]; sourceSha256: string; importer: string }
  | { ok: false; errors: ImportError[] };

// ---------------------------------------------------------------- scanner

interface El {
  name: string;
  attrs: Map<string, string>;
  line: number;
  column: number;
  children: El[];
  /** Line of the first non-whitespace text directly inside this element, if any. */
  textLine: number;
}

class Fail extends Error {
  constructor(readonly err: ImportError) {
    super(err.message);
  }
}

const xmlFail = (line: number, column: number, message: string): never => {
  throw new Fail({ code: 'E_XML', line, column, message });
};

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

/** Reads the file into an element tree, or throws Fail. Linear in the size of the text. */
function scan(input: string): El {
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0; // a byte order mark is allowed
  let line = 1;
  let col = 1;
  let elements = 0;
  const n = input.length;

  const adv = (k: number): void => {
    for (let j = 0; j < k; j++) {
      if (input[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  const peek = (s: string): boolean => input.startsWith(s, i);
  const skipWs = (): void => {
    while (i < n && (input[i] === ' ' || input[i] === '\t' || input[i] === '\n' || input[i] === '\r')) adv(1);
  };
  const name = (): string => {
    const startCol = col;
    if (i >= n || !NAME_START.test(input[i]!)) xmlFail(line, startCol, 'an element or attribute name was expected here');
    let j = i + 1;
    while (j < n && NAME_CHAR.test(input[j]!)) j++;
    if (j - i > MAX_NAME) throw new Fail({ code: 'E_IMPORT_LIMIT', line, column: startCol, message: `a name is longer than ${MAX_NAME} characters` });
    const s = input.slice(i, j);
    adv(j - i);
    return s;
  };
  const decode = (raw: string, atLine: number, atCol: number): string => {
    if (!raw.includes('&')) return raw;
    return raw.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'amp') return '&';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff))) {
        return xmlFail(atLine, atCol, 'a character reference names a character that XML does not allow');
      }
      return String.fromCodePoint(cp);
    });
  };
  /** After decoding the only & left would be an entity we do not know (or a bare ampersand). */
  const checkNoAmp = (decoded: string, raw: string, atLine: number, atCol: number): void => {
    // a decoded "&amp;" legitimately leaves a literal & in the value; only an undecodable ampersand in the RAW text is an error
    if (/&(?!(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);)/.test(raw)) xmlFail(atLine, atCol, 'only the five predefined entities and numeric character references are accepted');
    void decoded;
  };

  // prolog: the XML declaration (only first), comments, whitespace
  if (peek('<?xml') && /\s/.test(input[i + 5] ?? '')) {
    const end = input.indexOf('?>', i);
    if (end < 0) xmlFail(line, col, 'the XML declaration is not closed');
    adv(end + 2 - i);
  }
  let root: El | null = null;
  const stack: El[] = [];

  while (i < n) {
    // text up to the next markup
    const lt = input.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    const text = input.slice(i, textEnd);
    if (text.length > 0) {
      const target = stack[stack.length - 1];
      if (text.trim() !== '') {
        if (!target) xmlFail(line, col, 'text outside the root element');
        if (target && target.textLine === 0) {
          const before = text.length - text.trimStart().length;
          target.textLine = line + (text.slice(0, before).match(/\n/g)?.length ?? 0);
        }
        checkNoAmp(decode(text, line, col), text, line, col);
      }
      adv(text.length);
    }
    if (i >= n) break;
    // markup
    if (peek('<!--')) {
      const end = input.indexOf('-->', i + 4);
      if (end < 0) xmlFail(line, col, 'a comment is not closed');
      if (input.slice(i + 4, end).includes('--')) xmlFail(line, col, 'a comment contains "--"');
      adv(end + 3 - i);
    } else if (peek('<![CDATA[')) {
      xmlFail(line, col, 'a CDATA section is not accepted');
    } else if (peek('<!')) {
      xmlFail(line, col, 'a DTD, DOCTYPE or entity declaration is not accepted');
    } else if (peek('<?')) {
      xmlFail(line, col, 'a processing instruction is not accepted');
    } else if (peek('</')) {
      const startLine = line;
      const startCol = col;
      adv(2);
      const nm = name();
      skipWs();
      if (input[i] !== '>') xmlFail(line, col, 'an end tag must end with ">"');
      adv(1);
      const top = stack.pop();
      if (!top || top.name !== nm) xmlFail(startLine, startCol, `the end tag </${nm}> does not match ${top ? `<${top.name}> opened at line ${top.line}` : 'an open element'}`);
    } else {
      const startLine = line;
      const startCol = col;
      adv(1); // <
      if (root && stack.length === 0) xmlFail(startLine, startCol, 'a second root element');
      const nm = name();
      const el: El = { name: nm, attrs: new Map(), line: startLine, column: startCol, children: [], textLine: 0 };
      if (++elements > MAX_ELEMENTS) throw new Fail({ code: 'E_IMPORT_LIMIT', line: startLine, column: startCol, message: `the file has more than ${MAX_ELEMENTS} elements` });
      for (;;) {
        const hadWs = /\s/.test(input[i] ?? '');
        skipWs();
        if (input[i] === '>' || peek('/>')) break;
        if (!hadWs) xmlFail(line, col, 'attributes must be separated by white space');
        if (i >= n) xmlFail(line, col, 'the file ends inside a tag');
        const aLine = line;
        const aCol = col;
        const an = name();
        skipWs();
        if (input[i] !== '=') xmlFail(line, col, `attribute ${an} needs a value: name="value"`);
        adv(1);
        skipWs();
        const q = input[i];
        if (q !== '"' && q !== "'") xmlFail(line, col, 'an attribute value must be in quotes');
        adv(1);
        const close = input.indexOf(q!, i);
        if (close < 0) xmlFail(line, col, 'an attribute value is not closed');
        const raw = input.slice(i, close);
        if (raw.length > MAX_ATTR_VALUE) throw new Fail({ code: 'E_IMPORT_LIMIT', line: aLine, column: aCol, message: `an attribute value is longer than ${MAX_ATTR_VALUE} characters` });
        if (raw.includes('<')) xmlFail(aLine, aCol, 'an attribute value contains "<"');
        checkNoAmp(raw, raw, aLine, aCol);
        if (el.attrs.has(an)) xmlFail(aLine, aCol, `attribute ${an} appears twice`);
        if (el.attrs.size >= MAX_ATTRS) throw new Fail({ code: 'E_IMPORT_LIMIT', line: aLine, column: aCol, message: `an element has more than ${MAX_ATTRS} attributes` });
        el.attrs.set(an, decode(raw, aLine, aCol));
        adv(close + 1 - i);
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(el);
      else root = el;
      if (peek('/>')) adv(2);
      else {
        adv(1);
        if (stack.length >= MAX_DEPTH) throw new Fail({ code: 'E_IMPORT_LIMIT', line: startLine, column: startCol, message: `elements are nested deeper than ${MAX_DEPTH}` });
        stack.push(el);
      }
    }
  }
  if (stack.length) xmlFail(stack[0]!.line, stack[0]!.column, `<${stack[stack.length - 1]!.name}> is never closed`);
  if (!root) xmlFail(1, 1, 'the file has no root element');
  return root!;
}

// ---------------------------------------------------------------- semantics

const ID = /^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/;
const FLOAT = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
const CONNECTIVES = new Set(['and', 'or', 'atleast']);
const REFS = new Set(['basic-event', 'gate', 'event']);
/** Elements the policy names as outside the subset, for a clearer message than "unknown". */
const KNOWN_OUTSIDE = new Set([
  'define-event-tree', 'define-sequence', 'define-initiating-event', 'define-functional-event', 'define-branch', 'define-CCF-group', 'define-parameter', 'define-house-event', 'define-component',
  'define-substitution', 'define-rule', 'define-alignment', 'define-extern-function', 'define-event', 'label', 'attributes', 'attribute', 'house-event', 'parameter', 'not', 'xor', 'nand', 'nor', 'null', 'iff',
  'imply', 'cardinality', 'constant', 'exponential', 'GLM', 'Weibull', 'periodic-test', 'lognormal-deviate', 'normal-deviate', 'uniform-deviate', 'gamma-deviate', 'beta-deviate', 'histogram', 'extern-function',
  'initialize', 'initiating-event', 'collect-expression', 'collect-formula', 'rule', 'instruction', 'test-initiating-event', 'test-functional-event', 'fork', 'path', 'if', 'else', 'case', 'block', 'event-tree',
]);

interface Def {
  name: string;
  line: number;
  column: number;
}

/** One reference found while reading formulas, resolved once every name is known. */
interface Ref {
  name: string;
  /** The element used: basic-event, gate or event. */
  kind: string;
  line: number;
  column: number;
}

interface Pending {
  id: string;
  line: number;
  column: number;
  type: 'and' | 'or' | 'atleast';
  threshold?: number;
  /** References and the ids of generated nested gates, in order. */
  inputs: (Ref | { generated: string })[];
}

export function importOpenPsa(text: string, opts: { now?: string } = {}): ImportResult {
  const errors: ImportError[] = [];
  const err = (e: ImportError): void => {
    if (errors.length < MAX_ERRORS) errors.push(e);
  };
  const unsupported = (construct: string, el: { line: number; column: number }, why: string): void => err({ code: 'E_UNSUPPORTED', line: el.line, column: el.column, construct, message: `${construct} is outside the supported subset: ${why}` });

  if (typeof text !== 'string') return { ok: false, errors: [{ code: 'E_XML', line: 0, column: 0, message: 'the input is not text' }] };
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) return { ok: false, errors: [{ code: 'E_IMPORT_LIMIT', line: 0, column: 0, message: `the file is larger than ${MAX_IMPORT_BYTES} bytes` }] };

  let root: El;
  try {
    root = scan(text);
  } catch (e) {
    if (e instanceof Fail) return { ok: false, errors: [e.err] };
    throw e;
  }

  // ---- the document structure
  if (root.name !== 'opsa-mef') {
    return { ok: false, errors: [{ code: 'E_UNSUPPORTED', line: root.line, column: root.column, construct: `<${root.name}>`, message: `the root element is <${root.name}>, not <opsa-mef>` }] };
  }
  for (const a of root.attrs.keys()) {
    if (!(a === 'version' || a === 'name' || a.startsWith('xmlns') || a.startsWith('xsi:'))) unsupported(`attribute ${a}`, root, 'the root element carries it');
  }
  if (root.textLine) err({ code: 'E_UNSUPPORTED', line: root.textLine, column: 1, construct: 'text content', message: 'text content is outside the supported subset: the model is written in attributes' });

  const trees = root.children.filter((c) => c.name === 'define-fault-tree');
  const dataBlocks = root.children.filter((c) => c.name === 'model-data');
  for (const c of root.children) {
    if (c.name === 'define-fault-tree' || c.name === 'model-data') continue;
    unsupported(`<${c.name}>`, c, KNOWN_OUTSIDE.has(c.name) ? 'it has no meaning in a V1 static fault tree' : 'it is not part of the documented subset');
  }
  if (trees.length === 0 && errors.length === 0) err({ code: 'E_UNSUPPORTED', line: root.line, column: root.column, construct: '<opsa-mef>', message: 'there is no <define-fault-tree>' });
  if (trees.length > 1) unsupported('a second <define-fault-tree>', trees[1]!, 'one fault tree per file');
  if (dataBlocks.length > 1) unsupported('a second <model-data>', dataBlocks[1]!, 'one block of model data per file');
  const tree = trees[0];
  if (!tree) return { ok: false, errors };

  const treeName = tree.attrs.get('name');
  if (treeName === undefined) err({ code: 'E_UNSUPPORTED', line: tree.line, column: tree.column, construct: '<define-fault-tree>', message: '<define-fault-tree> has no name' });
  for (const a of tree.attrs.keys()) if (a !== 'name') unsupported(`attribute ${a}`, tree, 'on <define-fault-tree>');
  if (tree.textLine) err({ code: 'E_UNSUPPORTED', line: tree.textLine, column: 1, construct: 'text content', message: 'text content is outside the supported subset' });

  const events = new Map<string, { def: Def; probability: number }>();
  const gateDefs = new Map<string, { def: Def; el: El }>();
  const defined = new Map<string, Def & { kind: 'event' | 'gate' }>();
  const define = (kind: 'event' | 'gate', nm: string | undefined, el: El): string | null => {
    if (nm === undefined || nm === '') {
      err({ code: 'E_UNSUPPORTED', line: el.line, column: el.column, construct: `<${el.name}>`, message: `<${el.name}> has no name` });
      return null;
    }
    if (!ID.test(nm)) {
      err({ code: 'E_ID_FORMAT', line: el.line, column: el.column, message: `the name ${JSON.stringify(nm)} cannot be used: a name is 1 to 64 letters, digits, underscores and inner dashes, starting with a letter or underscore` });
      return null;
    }
    const prior = defined.get(nm);
    if (prior) {
      err({ code: 'E_DUP_ID', line: el.line, column: el.column, message: `the name ${JSON.stringify(nm)} is already used by the ${prior.kind} defined at line ${prior.line}; events and gates share one namespace` });
      return null;
    }
    defined.set(nm, { name: nm, line: el.line, column: el.column, kind });
    return nm;
  };

  const readEvent = (el: El): void => {
    for (const a of el.attrs.keys()) if (a !== 'name') unsupported(`attribute ${a}`, el, 'on <define-basic-event>');
    if (el.textLine) err({ code: 'E_UNSUPPORTED', line: el.textLine, column: 1, construct: 'text content', message: 'text content is outside the supported subset' });
    const nm = define('event', el.attrs.get('name'), el);
    const kids = el.children;
    let p: number | null = null;
    if (kids.length === 0) err({ code: 'E_PROB_RANGE', line: el.line, column: el.column, message: `the basic event ${JSON.stringify(el.attrs.get('name') ?? '')} has no probability` });
    for (const k of kids) {
      if (k.name !== 'float') {
        unsupported(`<${k.name}>`, k, KNOWN_OUTSIDE.has(k.name) ? 'only a literal <float value="..."/> probability is supported (no expressions, parameters or distributions)' : 'not part of the documented subset');
        continue;
      }
      if (p !== null) {
        unsupported('a second <float>', k, 'one probability per basic event');
        continue;
      }
      for (const a of k.attrs.keys()) if (a !== 'value') unsupported(`attribute ${a}`, k, 'on <float>');
      if (k.children.length || k.textLine) unsupported('content inside <float>', k, 'a probability is a bare <float value="..."/>');
      const raw = k.attrs.get('value');
      if (raw === undefined || !FLOAT.test(raw.trim())) {
        err({ code: 'E_PROB_RANGE', line: k.line, column: k.column, message: `${JSON.stringify(raw ?? '')} is not a number` });
        continue;
      }
      const v = Number(raw.trim());
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        err({ code: 'E_PROB_RANGE', line: k.line, column: k.column, message: `the probability ${raw.trim()} is outside 0 to 1` });
        continue;
      }
      p = v;
    }
    if (nm !== null && p !== null) events.set(nm, { def: { name: nm, line: el.line, column: el.column }, probability: p });
  };

  const contents = [...tree.children, ...dataBlocks.flatMap((b) => b.children)];
  for (const b of dataBlocks) {
    for (const a of b.attrs.keys()) unsupported(`attribute ${a}`, b, 'on <model-data>');
    if (b.textLine) err({ code: 'E_UNSUPPORTED', line: b.textLine, column: 1, construct: 'text content', message: 'text content is outside the supported subset' });
  }
  const dataSet = new Set(dataBlocks.flatMap((b) => b.children));
  for (const c of contents) {
    if (c.name === 'define-basic-event') readEvent(c);
    else if (c.name === 'define-gate' && !dataSet.has(c)) {
      for (const a of c.attrs.keys()) if (a !== 'name') unsupported(`attribute ${a}`, c, 'on <define-gate>');
      const nm = define('gate', c.attrs.get('name'), c);
      if (nm !== null) gateDefs.set(nm, { def: { name: nm, line: c.line, column: c.column }, el: c });
    } else unsupported(`<${c.name}>`, c, KNOWN_OUTSIDE.has(c.name) ? 'it has no meaning in a V1 static fault tree' : dataSet.has(c) ? 'only basic events may appear in <model-data>' : 'not part of the documented subset');
  }

  // ---- formulas
  const pending: Pending[] = [];
  const aliases = new Map<string, Ref>(); // pass-through gates: name -> what they are
  const generatedIds = new Set<string>();
  const notes: ImportNote[] = [];
  const freshId = (base: string): string => {
    for (let k = 1; k <= MAX_ELEMENTS + 1; k++) {
      const suffix = `_${k}`;
      const id = `${base.slice(0, 64 - suffix.length)}${suffix}`; // the suffix is what makes the name new, so it is never cut off
      if (!defined.has(id) && !generatedIds.has(id)) {
        generatedIds.add(id);
        return id;
      }
    }
    throw new Fail({ code: 'E_IMPORT_LIMIT', line: 0, column: 0, message: `no free name was found for a gate nested in ${base}` });
  };
  const refOf = (el: El): Ref | null => {
    for (const a of el.attrs.keys()) if (a !== 'name') unsupported(`attribute ${a}`, el, `on <${el.name}>`);
    if (el.children.length || el.textLine) unsupported(`content inside <${el.name}>`, el, 'a reference is an empty element');
    const nm = el.attrs.get('name');
    if (nm === undefined || nm === '') {
      err({ code: 'E_MISSING_REF', line: el.line, column: el.column, message: `<${el.name}> names nothing` });
      return null;
    }
    return { name: nm, kind: el.name, line: el.line, column: el.column };
  };
  /** Reads a connective into pending gates; returns the id of the gate it became. */
  const connective = (el: El, id: string): void => {
    for (const a of el.attrs.keys()) if (!(el.name === 'atleast' && a === 'min')) unsupported(`attribute ${a}`, el, `on <${el.name}>`);
    if (el.textLine) err({ code: 'E_UNSUPPORTED', line: el.textLine, column: 1, construct: 'text content', message: 'text content is outside the supported subset' });
    let threshold: number | undefined;
    if (el.name === 'atleast') {
      const raw = el.attrs.get('min');
      if (raw === undefined || !/^[0-9]{1,6}$/.test(raw)) err({ code: 'E_VOTE_RANGE', line: el.line, column: el.column, message: `<atleast> needs an integer min, found ${JSON.stringify(raw ?? '')}` });
      else threshold = Number(raw);
    }
    const inputs: Pending['inputs'] = [];
    for (const k of el.children) {
      if (REFS.has(k.name)) {
        const r = refOf(k);
        if (r) inputs.push(r);
      } else if (CONNECTIVES.has(k.name)) {
        const g = freshId(id);
        notes.push({ kind: 'generated-gate', line: k.line, message: `a nested <${k.name}> inside ${id} became the gate ${g}` });
        connective(k, g);
        inputs.push({ generated: g });
      } else unsupported(`<${k.name}>`, k, KNOWN_OUTSIDE.has(k.name) ? 'only and, or, atleast and references are supported' : 'not part of the documented subset');
    }
    pending.push({ id, line: el.line, column: el.column, type: el.name as 'and' | 'or' | 'atleast', ...(threshold !== undefined ? { threshold } : {}), inputs });
  };
  for (const [nm, { el }] of gateDefs) {
    if (el.textLine) err({ code: 'E_UNSUPPORTED', line: el.textLine, column: 1, construct: 'text content', message: 'text content is outside the supported subset' });
    if (el.children.length !== 1) {
      err({ code: 'E_UNSUPPORTED', line: el.line, column: el.column, construct: '<define-gate>', message: `<define-gate ${nm}> must hold exactly one formula, it holds ${el.children.length}` });
      continue;
    }
    const f = el.children[0]!;
    if (CONNECTIVES.has(f.name)) connective(f, nm);
    else if (REFS.has(f.name)) {
      const r = refOf(f);
      if (r) {
        aliases.set(nm, r);
        notes.push({ kind: 'pass-through', line: el.line, message: `the gate ${nm} only repeats ${r.name}, so ${nm} is replaced by ${r.name} wherever it is used` });
      }
    } else unsupported(`<${f.name}>`, f, KNOWN_OUTSIDE.has(f.name) ? 'only and, or, atleast and a bare reference are supported formulas' : 'not part of the documented subset');
  }
  if (errors.length) return { ok: false, errors };

  // ---- resolve names (aliases first)
  const lineOf = (id: string): number => defined.get(id)?.line ?? pending.find((p) => p.id === id)?.line ?? 0;
  const kindOf = (id: string): 'event' | 'gate' | null => {
    if (events.has(id)) return 'event';
    if (gateDefs.has(id)) return 'gate'; // a generated gate is never named in the file, so a reference to one is a missing name
    return null;
  };
  // what each pass-through gate finally stands for (null: a loop or a missing name): a chain of n gates is walked once, not n times
  const aliasMemo = new Map<string, string | null>();
  const resolve = (start: Ref): string | null => {
    // follow pass-through gates one by one (a chain can be long, so no recursion), each reference checked as written
    const seen = new Set<string>();
    const trail: string[] = [];
    const remember = (result: string | null): string | null => {
      for (const t of trail) aliasMemo.set(t, result);
      return result;
    };
    let r = start;
    for (let al = aliases.get(r.name); al; al = aliases.get(r.name)) {
      if (r.kind === 'basic-event') err({ code: 'E_MISSING_REF', line: r.line, column: r.column, message: `${JSON.stringify(r.name)} is a gate, but it is referred to as a basic event` });
      const known = aliasMemo.get(r.name);
      if (known !== undefined) return remember(known); // the rest of this chain was walked before; any error in it was reported then
      if (seen.has(r.name)) {
        err({ code: 'E_CYCLE', line: r.line, column: r.column, message: `pass-through gates refer to each other in a loop through ${r.name}` });
        return remember(null);
      }
      seen.add(r.name);
      trail.push(r.name);
      r = al;
    }
    const k = kindOf(r.name);
    if (k === null) {
      err({ code: 'E_MISSING_REF', line: r.line, column: r.column, message: `${JSON.stringify(r.name)} is not defined` });
      return remember(null);
    }
    // a reference element must match what the name is (a <basic-event> that names a gate is a mistake in the file)
    if (r.kind === 'basic-event' && k !== 'event') err({ code: 'E_MISSING_REF', line: r.line, column: r.column, message: `${JSON.stringify(r.name)} is a gate, but it is referred to as a basic event` });
    else if (r.kind === 'gate' && k !== 'gate') err({ code: 'E_MISSING_REF', line: r.line, column: r.column, message: `${JSON.stringify(r.name)} is a basic event, but it is referred to as a gate` });
    return remember(r.name);
  };

  const referencedNames = new Set<string>();
  const nativeGates: { id: string; type: 'and' | 'or' | 'atleast'; inputs: string[]; threshold?: number }[] = [];
  for (const g of pending) {
    const inputs: string[] = [];
    for (const i of g.inputs) {
      if ('generated' in i) inputs.push(i.generated);
      else {
        referencedNames.add(i.name);
        const walked = new Set<string>([i.name]); // pass-through gates may refer to each other in a loop: walk each name once
        for (let a = aliases.get(i.name); a && !walked.has(a.name); a = aliases.get(a.name)) {
          walked.add(a.name);
          referencedNames.add(a.name);
        }
        const id = resolve(i);
        if (id !== null) inputs.push(id);
      }
    }
    nativeGates.push({ id: g.id, type: g.type, inputs, ...(g.threshold !== undefined ? { threshold: g.threshold } : {}) });
  }
  for (const [nm, a] of aliases) {
    referencedNames.add(a.name);
    if (!defined.has(a.name)) err({ code: 'E_MISSING_REF', line: a.line, column: a.column, message: `${JSON.stringify(a.name)} (the target of the pass-through gate ${nm}) is not defined` });
    else resolve({ name: nm, kind: 'gate', line: lineOf(nm), column: 1 });
  }
  if (errors.length) return { ok: false, errors };

  // ---- the top: the one gate nothing refers to
  const unreferenced = [...gateDefs.keys()].filter((g) => !referencedNames.has(g));
  let top: string | null = null;
  if (gateDefs.size === 0) {
    if (events.size === 1) top = [...events.keys()][0]!;
    else err({ code: 'E_NO_TOP', line: tree.line, column: tree.column, message: 'there are no gates, so there is no top event to analyse' });
  } else if (unreferenced.length === 1) {
    top = resolve({ name: unreferenced[0]!, kind: 'gate', line: lineOf(unreferenced[0]!), column: 1 });
  } else if (unreferenced.length === 0) {
    err({ code: 'E_NO_TOP', line: tree.line, column: tree.column, message: 'every gate is referred to by another gate, so no gate can be the top (a loop?)' });
  } else {
    err({ code: 'E_UNSUPPORTED', line: lineOf(unreferenced[1]!), column: 1, construct: 'several top gates', message: `more than one gate is not referred to by any other (${unreferenced.map((g) => `${g} at line ${lineOf(g)}`).join(', ')}): the top event is ambiguous` });
  }
  if (errors.length || top === null) return { ok: false, errors };

  // ---- the native document, checked by the same validator as every other model
  const keptGates = nativeGates.filter((g) => !aliases.has(g.id));
  const stamp = opts.now ?? new Date().toISOString();
  const doc = {
    schema: { id: 'sneed.fault-tree', version: 1 },
    model: { id: 'imported', name: (treeName ?? 'Imported model').slice(0, 200) || 'Imported model', created: stamp, updated: stamp },
    assumptions: { probability_model: 'constant', independence: 'declared-independent', coherence: 'coherent', time: 'none' },
    top,
    events: [...events.entries()].map(([id, e]) => ({ id, probability: e.probability })),
    gates: keptGates,
  };
  const v = validateModel(doc);
  for (const issue of v.errors) {
    const id = issue.ids?.[0];
    const line = id !== undefined ? lineOf(id) : 0;
    const code = (['E_ID_FORMAT', 'E_DUP_ID', 'E_PROB_RANGE', 'E_NO_TOP', 'E_MISSING_REF', 'E_CYCLE', 'E_GATE_ARITY', 'E_VOTE_RANGE', 'E_VOTE_DUP'] as string[]).includes(issue.code) ? (issue.code as ImportCode) : 'E_SCHEMA';
    err({ code, line, column: 1, message: issue.message });
  }
  if (errors.length) return { ok: false, errors };
  for (const w of v.warnings) notes.push({ kind: 'warning', line: w.ids?.[0] !== undefined ? lineOf(w.ids[0]) : 0, message: w.message });
  notes.sort((a, b) => a.line - b.line);

  return {
    ok: true,
    doc,
    text: JSON.stringify(doc, null, 2) + '\n',
    notes,
    sourceSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    importer: IMPORTER_VERSION,
  };
}

export type { NativeModel };
