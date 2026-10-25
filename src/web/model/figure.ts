// A fault tree as a standalone figure for a lab report: one SVG document with the drawing, a caption and, when there is a current result,
// the result with its status. Pure text in, text out: no DOM, no fonts, no external files, no scripts, no CSS variables, so the same
// string opens in any viewer, converts to PNG in the browser and prints in black and white (shape and line style carry the meaning,
// never colour). The caption states what a reader must not miss: a result that is not complete is labelled diagnostic only.
import type { ResultRecord } from '../../core/result.js';
import type { CrossCheckInfo } from '../api.js';
import { CAVEAT_TEXT, METHOD_TEXT, reasonText } from '../ui/hints.js';
import { findEvent, findGate, groupOf, groups, type Doc } from './doc.js';
import { buildVisual, type Visual, type VisualNode } from './visual.js';

export interface FigureResult {
  record: ResultRecord;
  /** True when the model or method changed after this result: it is then not described as the result for this drawing. */
  stale: boolean;
  /** The second engine's answer, when both were asked for: a disagreement or a failed comparison is part of the result. */
  cross?: CrossCheckInfo;
}

export interface FigureOptions {
  /** Shown in the caption; default is none, so the same input gives the same bytes. */
  generated?: string;
  result?: FigureResult | null;
  /** Fixed text, for the footer. */
  appName?: string;
}

export const FIGURE_MARGIN = 24;
export const FONT = 'Arial, Helvetica, sans-serif';
export const LINE = 16;
export const CHAR_W = 6.6; // an estimate of the average width of 11 px text, to size the page

/** Characters XML 1.0 does not allow at all (control characters, lone surrogates, U+FFFE and U+FFFF); a model name may hold them, a document may not. */
const XML_INVALID = /[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
export const esc = (t: string): string => t.replace(XML_INVALID, '\uFFFD').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const short = (t: string, max: number): string => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
export const num = (n: number): string => String(Math.round(n * 100) / 100);
/** Breaks a line at spaces to at most `max` characters; a continuation keeps the indent of its line. */
export function wrapText(line: string, max: number): string[] {
  const indent = /^ */.exec(line)![0];
  const words = line.trim().split(/ +/);
  const out: string[] = [];
  let cur = indent;
  for (const w of words) {
    const next = cur.trim() === '' ? indent + w : `${cur} ${w}`;
    if (next.length > max && cur.trim() !== '') {
      out.push(cur);
      cur = indent + w;
    } else cur = next;
  }
  out.push(cur);
  return out;
}
const prob = (p: number): string => (p === 0 || p === 1 ? String(p) : p >= 0.001 && p < 1 ? String(Number(p.toPrecision(6))) : p.toExponential(5));

/** Words for the result block, one string per line. */
export function resultLines(r: FigureResult | null | undefined): string[] {
  if (!r) return ['No result for this drawing: the model has not been run.'];
  const rec = r.record;
  const out: string[] = [];
  const ok = rec.status === 'completed' && rec.completeness === 'complete';
  if (r.stale) out.push('NO CURRENT RESULT: the model or the method changed after the last run, so the numbers for it are not shown.');
  else if (!ok) {
    out.push(`DIAGNOSTIC ONLY: the run is ${rec.status} / ${rec.completeness}, so this is not an analysis result.`);
    for (const reason of rec.reasons) out.push(`  ${reasonText(reason)}`);
  }
  if (!r.stale) {
    out.push(`Method: ${METHOD_TEXT[rec.method] ?? rec.method}. Engine: ${rec.engine.name} ${rec.engine.version}. Status: ${rec.status} / ${rec.completeness}.`);
    if (rec.top_event_probability !== null) out.push(`Top event probability: ${prob(rec.top_event_probability)}${rec.method === 'exact' ? '' : ' (approximation)'}.`);
    if (rec.common_cause) {
      out.push('Common-cause groups used (beta-factor): this is a different kind of result from one with independent events.');
      if (typeof rec.common_cause.independent_value === 'number') out.push(`The same events as independent events would give ${prob(rec.common_cause.independent_value)}.`);
    }
    out.push(`Minimal cut sets: ${rec.minimal_cut_sets.length}.`);
    const c = r.cross;
    if (c) {
      if ('unavailable' in c) out.push(`Cross-check: no second opinion (${c.reason}).`);
      else if (c.agree) out.push(`Cross-check: ${c.engine.name} ${c.engine.version} gives the same probability and the same minimal cut sets.`);
      else {
        out.push('CROSS-CHECK DISAGREEMENT: the second engine differs; treat these numbers as unverified until this is explained.');
        for (const d of c.differences) out.push(`  ${d}`);
      }
    }
    for (const c of rec.caveats) out.push(CAVEAT_TEXT[c] ?? c);
    out.push(`Model hash ${rec.input_hashes.model_hash.slice(0, 12)}.`);
  }
  return out;
}

function nodeSvg(n: VisualNode, doc: Doc): string {
  const hw = n.w / 2;
  const hh = n.h / 2;
  const gate = n.kind === 'gate' ? findGate(doc, n.id) : undefined;
  const event = n.kind === 'event' ? findEvent(doc, n.id) : undefined;
  const name = (gate ?? event ?? findGate(doc, n.id) ?? findEvent(doc, n.id))?.name;
  const isTop = doc.top === n.id && (n.kind === 'event' || n.kind === 'gate');
  let l1 = n.id;
  let l2 = '';
  if (n.kind === 'event') {
    l2 = `p = ${event ? event.probability : '?'}`;
    if (name) l1 = `${n.id} ${short(name, 13)}`;
  } else if (n.kind === 'gate' && gate) {
    const type = gate.type === 'atleast' ? `${gate.threshold ?? 'K'} of ${gate.inputs.length}` : gate.type.toUpperCase();
    l1 = `${n.id} · ${type}`;
    l2 = name ? short(name, 18) : '';
  } else if (n.kind === 'reference') l1 = `↪ ${n.id}`;
  else l1 = `? ${n.id}`;
  const shape =
    n.kind === 'event'
      ? `<ellipse rx="${num(hw)}" ry="${num(hh)}" fill="#fff" stroke="#000" stroke-width="1.5"/>`
      : `<rect x="${num(-hw)}" y="${num(-hh)}" width="${num(n.w)}" height="${num(n.h)}" rx="${n.kind === 'gate' ? 10 : 8}" fill="#fff" stroke="#000" stroke-width="${n.kind === 'gate' ? 2 : 1.25}"${n.kind === 'gate' ? '' : ' stroke-dasharray="5 3"'}/>`;
  const text =
    n.kind === 'reference' || n.kind === 'missing'
      ? `<text x="0" y="4" text-anchor="middle" font-size="11">${esc(short(l1, 20))}</text>`
      : `<text x="0" y="-3" text-anchor="middle" font-size="11" font-weight="bold">${esc(short(l1, 20))}</text><text x="0" y="14" text-anchor="middle" font-size="10">${esc(l2)}</text>`;
  const top = isTop ? `<rect x="${num(-hw + 2)}" y="${num(-hh - 9)}" width="34" height="16" rx="8" fill="#000"/><text x="${num(-hw + 19)}" y="${num(-hh + 3)}" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">TOP</text>` : '';
  const member = n.kind === 'event' ? groupOf(doc, n.id) : undefined; // print has no colour: the group is named on the node too
  const tag = member ? `<text x="0" y="${num(hh + 12)}" text-anchor="middle" font-size="9">in ${esc(short(member.name?.trim() || member.id, 14))}</text>` : '';
  return `<g transform="translate(${num(n.x)} ${num(n.y)})">${shape}${text}${top}${tag}</g>`;
}

/** The dash-dot rectangle round the members of each common-cause group, with its name and beta. */
function groupBoxesSvg(v: Visual, doc: Doc): string {
  return groups(doc)
    .map((g) => {
      const members = v.nodes.filter((n) => n.kind === 'event' && g.members.includes(n.id));
      if (members.length === 0) return '';
      const x1 = Math.min(...members.map((n) => n.x - n.w / 2)) - 16;
      const y1 = Math.min(...members.map((n) => n.y - n.h / 2)) - 24;
      const x2 = Math.max(...members.map((n) => n.x + n.w / 2)) + 16;
      const y2 = Math.max(...members.map((n) => n.y + n.h / 2)) + 20;
      return `<rect x="${num(x1)}" y="${num(y1)}" width="${num(x2 - x1)}" height="${num(y2 - y1)}" rx="12" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="10 3 2 3"/><text x="${num(x1 + 8)}" y="${num(y1 + 13)}" font-size="10" font-weight="bold">${esc(short(`${g.name?.trim() || g.id} · beta ${g.beta}`, Math.max(12, Math.floor((x2 - x1) / 6))))}</text>`;
    })
    .join('');
}

function edgePath(v: Visual, from: string, to: string): string {
  const a = v.byKey.get(from)!;
  const b = v.byKey.get(to)!;
  const x1 = a.x;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y - b.h / 2;
  const dy = Math.max(24, Math.abs(y2 - y1) / 2);
  return `M ${num(x1)} ${num(y1)} C ${num(x1)} ${num(y1 + dy)}, ${num(x2)} ${num(y2 - dy)}, ${num(x2)} ${num(y2)}`;
}

/** The standalone SVG document for the model's drawing, with its caption and result block. */
export function figureSvg(doc: Doc, opts: FigureOptions = {}): string {
  const v = buildVisual(doc);
  const m = FIGURE_MARGIN;
  const appName = opts.appName ?? 'SNEED fault-tree editor';
  const head = [short(doc.model.name || 'Untitled model', 80), `Top event: ${doc.top || '(none)'} · ${doc.events.length} basic event${doc.events.length === 1 ? '' : 's'} · ${doc.gates.length} gate${doc.gates.length === 1 ? '' : 's'}`];
  const gs = groups(doc);
  const legend = `Ellipse: basic event. Rectangle: gate. Dashed rectangle: the same event or gate used again (one failure, not a copy).${gs.length ? ' Dash-dot rectangle: a common-cause group.' : ''}`;
  const assumptions = gs.length
    ? 'Constant probabilities; basic events independent, except the members of each common-cause group (beta-factor model), which can fail together. A probability here is not a frequency and not a plant risk figure.'
    : 'Constant probabilities; basic events independent, as declared by the model. A probability here is not a frequency and not a plant risk figure.';
  const groupLines = gs.map((g) => `Common-cause group ${g.name?.trim() || g.id}: ${g.members.join(', ')}; beta ${g.beta}.`);
  const headH = 20 + head.length * LINE + 10;
  const treeW = Math.max(v.bounds.w, 1);
  const treeH = Math.max(v.bounds.h, 1);
  const contentW = Math.max(treeW, 640);
  const width = Math.ceil(contentW + 2 * m);
  const foot = [legend, assumptions, ...groupLines, ...resultLines(opts.result), `${appName}${opts.generated ? ` · ${opts.generated}` : ''}`].flatMap((t) => wrapText(t, Math.floor(contentW / CHAR_W)));
  const footTop = m + headH + treeH + 24;
  const height = Math.ceil(footTop + foot.length * LINE + m);
  const tx = m + (width - 2 * m - treeW) / 2 - v.bounds.x;
  const ty = m + headH - v.bounds.y;

  const title = `Fault tree: ${doc.model.name || 'Untitled model'}`;
  const desc = `${head[1]}. ${v.nodes.length === 0 ? 'The drawing is empty.' : `${v.nodes.length} drawn nodes.`}`;
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}">`);
  parts.push(`<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);
  parts.push(`<text x="${m}" y="${m + 14}" font-size="16" font-weight="bold">${esc(head[0]!)}</text>`);
  parts.push(`<text x="${m}" y="${m + 14 + LINE + 4}" font-size="11">${esc(head[1]!)}</text>`);
  parts.push(`<g transform="translate(${num(tx)} ${num(ty)})">`);
  if (gs.length) parts.push(groupBoxesSvg(v, doc));
  parts.push(`<g fill="none" stroke="#000" stroke-width="1.25">${v.edges.map((e) => `<path d="${edgePath(v, e.from, e.to)}"${v.byKey.get(e.to)!.kind === 'reference' || v.byKey.get(e.to)!.kind === 'missing' ? ' stroke-dasharray="5 3"' : ''}/>`).join('')}</g>`);
  parts.push(v.nodes.map((n) => nodeSvg(n, doc)).join(''));
  parts.push(`</g>`);
  parts.push(`<line x1="${m}" y1="${footTop - 10}" x2="${width - m}" y2="${footTop - 10}" stroke="#000" stroke-width="0.75"/>`);
  foot.forEach((t, i) => parts.push(`<text x="${m}" y="${footTop + 4 + i * LINE}" font-size="11"${t.startsWith('DIAGNOSTIC') || t.startsWith('NO CURRENT') ? ' font-weight="bold"' : ''} xml:space="preserve">${esc(t)}</text>`));
  parts.push(`</svg>`);
  return parts.join('\n') + '\n';
}

/** A safe file stem for the model: letters, digits, dot, dash and underscore. */
export function figureFileStem(doc: Doc, fileName: string | null): string {
  const raw = fileName ?? doc.model.name ?? 'fault-tree';
  const stem = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/[.-]+$/, '').slice(0, 64);
  return stem || 'fault-tree';
}
