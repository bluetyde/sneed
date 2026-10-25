// Independent Node implementation of the canonical model_hash (plan 01).
// Uses JSON.stringify for numbers/strings (ECMAScript Number::toString is what RFC 8785 specifies).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite');
    return Object.is(v, -0) ? '0' : JSON.stringify(v);
  }
  return JSON.stringify(v);
}
function byId(items, kind) {
  const out = {};
  for (const it of items) {
    if (Object.prototype.hasOwnProperty.call(out, it.id)) throw new Error('E_DUP_ID ' + kind + ' ' + it.id);
    out[it.id] = it;
  }
  return out;
}
function projection(doc) {
  const evById = byId(doc.events, 'event');
  const gById = byId(doc.gates, 'gate');
  for (const id of Object.keys(evById)) if (id in gById) throw new Error('E_DUP_ID namespace clash');
  const gates = {};
  for (const [gid, g] of Object.entries(gById)) {
    const e = { type: g.type, inputs: [...g.inputs].sort() };
    if ('threshold' in g) e.threshold = g.threshold;
    gates[gid] = e;
  }
  const events = {};
  for (const [id, e] of Object.entries(evById)) events[id] = e.probability;
  const out = { schema: { id: doc.schema.id, version: doc.schema.version }, assumptions: doc.assumptions, top: doc.top, events, gates };
  const grById = byId(doc.common_cause_groups || [], 'group');
  for (const id of Object.keys(grById)) if (id in evById || id in gById) throw new Error('E_DUP_ID group namespace clash');
  if (Object.keys(grById).length) {
    out.common_cause_groups = {};
    for (const [gid, g] of Object.entries(grById)) out.common_cause_groups[gid] = { method: g.method, members: [...g.members].sort(), beta: g.beta };
  }
  return out;
}
const hash = (doc) => crypto.createHash('sha256').update(canon(projection(doc)), 'utf8').digest('hex');

const vec = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));
let bad = 0;
for (const c of vec.number_cases) {
  const got = canon(c.value === 'neg-zero' ? -0 : c.value);
  if (got !== c.canonical) { bad++; console.log('NUMBER FAIL', c.value, got, c.canonical); }
}
for (const c of vec.model_cases) {
  const doc = JSON.parse(c.document_json);
  const got = hash(doc);
  if (got !== c.model_hash) { bad++; console.log('HASH FAIL', c.id, got, c.model_hash); }
}
const hashOf = (id) => vec.model_cases.find((m) => m.id === id).model_hash;
for (const c of vec.model_cases) {
  if (c.same_as && c.model_hash !== hashOf(c.same_as)) { bad++; console.log('RELATION FAIL (should equal ' + c.same_as + ')', c.id); }
  if (c.differs_from && c.model_hash === hashOf(c.differs_from)) { bad++; console.log('RELATION FAIL (should differ from ' + c.differs_from + ')', c.id); }
}
const idRe = /^[A-Za-z_]([A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$/;
for (const c of vec.id_cases) if (idRe.test(c.id) !== c.valid) { bad++; console.log('ID FAIL', JSON.stringify(c.id)); }
for (const c of vec.refusal_cases) {
  try { hash(JSON.parse(c.document_json)); bad++; console.log('REFUSAL NOT RAISED', c.id); }
  catch (e) { if (!String(e.message).includes(c.error)) { bad++; console.log('WRONG ERROR', c.id, e.message); } }
}
console.log(`node: ${vec.number_cases.length} number + ${vec.model_cases.length} model + ${vec.id_cases.length} id + ${vec.refusal_cases.length} refusal vectors, failures=${bad}`);
process.exit(bad ? 1 : 0);
