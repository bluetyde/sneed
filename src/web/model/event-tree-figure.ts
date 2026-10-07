// An event tree as a standalone figure: one SVG document with the branching drawing, a caption, and the frequencies of the sequences when there
// is a current result. Pure text in, text out, like the fault-tree figure (figure.ts): no DOM, no fonts, no external files, no scripts, no CSS
// variables, so the same string opens in any viewer, converts to PNG in the browser and prints in black and white. Shape, line style and words
// carry the meaning, never colour. The drawing is a picture of the tables, not a second source: every number in it is a row of the result.
import { enumeratePaths, pathKey, type PathStep } from '../../core/event-tree-paths.js';
import { EVENT_TREE_ASSUMPTIONS_TEXT, endStateLabel, eventTreeFailureText, type EventTreeResult } from '../../core/event-tree-result.js';
import type { EtDoc } from './event-tree-doc.js';
import { CHAR_W, FONT, LINE, esc, num, short, wrapText } from './figure.js';

export const ET_FIGURE_MARGIN = 24;
/** More sequences than this are not drawn (the picture would be unreadable); the figure says so and the tables hold them all. */
export const MAX_DRAWN_SEQUENCES = 64;
const ROW_H = 46;
const COL_W = 156;
const IE_W = 150;
const GAP = 34;
const LEAF_W = 250;
const HEAD_H = 40;

export interface EtFigureResult {
  record: EventTreeResult;
  /** True when the tree or the approximation setting changed after this result: its numbers are then not shown. */
  stale: boolean;
}
export interface EtFigureOptions {
  result?: EtFigureResult | null;
  generated?: string;
  appName?: string;
}

const fmt = (p: number): string => (p === 0 ? '0' : p >= 1e-3 && p < 1e6 ? String(Number(p.toPrecision(6))) : p.toExponential(3));

type Item = { kind: 'leaf'; idx: number; key: string; y: number } | { kind: 'node'; col: number; works: Item; fails: Item; y: number };

/** The branching structure of the headings: a heading not asked on a path is passed over, so it has no node there. */
function buildTree(doc: EtDoc): { root: Item; leaves: string[] } {
  const leaves: string[] = [];
  const asked = (i: number, path: PathStep[]): boolean => {
    const c = doc.headings[i]!.asked_only_if;
    if (!c) return true;
    const earlier = path.find((s) => s.heading === c.heading);
    return earlier !== undefined && earlier.branch === c.branch;
  };
  const go = (i: number, path: PathStep[]): Item => {
    if (i === doc.headings.length) {
      const idx = leaves.length;
      leaves.push(pathKey(path));
      return { kind: 'leaf', idx, key: pathKey(path), y: idx * ROW_H + ROW_H / 2 };
    }
    if (!asked(i, path)) return go(i + 1, path);
    const id = doc.headings[i]!.id;
    const works = go(i + 1, [...path, { heading: id, branch: 'works' }]);
    const fails = go(i + 1, [...path, { heading: id, branch: 'fails' }]);
    return { kind: 'node', col: i, works, fails, y: (works.y + fails.y) / 2 };
  };
  return { root: go(0, []), leaves };
}

/** Words for the result block, one string per line. */
export function eventTreeResultLines(r: EtFigureResult | null | undefined): string[] {
  if (!r) return ['No result for this drawing: the event tree has not been analysed.'];
  const rec = r.record;
  if (r.stale) return ['NO CURRENT RESULT: the event tree (or the approximation setting) changed after the last analysis, so its numbers are not shown.'];
  if (rec.status !== 'completed' || rec.completeness !== 'complete') {
    return [`DIAGNOSTIC ONLY: the analysis is ${rec.status} / ${rec.completeness}, so there are no frequencies.`, ...rec.reasons.map((x) => `  ${eventTreeFailureText(x)}`)];
  }
  const out = [`Initiating event "${rec.initiating_event.name}": ${fmt(rec.initiating_event.frequency)} per year. Frequencies on the right are per year.`];
  if (rec.total) out.push(`Check: the sequence probabilities add up to ${fmt(rec.total.probability_sum)} (they must add to 1; difference ${rec.total.partition_error.toExponential(1)}).`);
  if (rec.approximation) out.push('The "success branches ignored" approximation was also computed; it is a different kind of number and is not drawn.');
  out.push(`Engine: ${rec.engine.name} ${rec.engine.version}. Event tree hash ${rec.input_hashes.tree_hash.slice(0, 12)}, model hash ${rec.input_hashes.model_hash.slice(0, 12)}.`);
  for (const c of rec.caveats) out.push(c);
  for (const w of rec.warnings) out.push(`Warning: ${w}`);
  return out;
}

/** The standalone SVG document for the event tree, with its caption and result block. */
export function eventTreeSvg(doc: EtDoc, opts: EtFigureOptions = {}): string {
  const m = ET_FIGURE_MARGIN;
  const appName = opts.appName ?? 'SNEED event-tree editor';
  const drawable = doc.sequences.length > 0 && enumeratePaths(doc.headings).length <= MAX_DRAWN_SEQUENCES;
  const n = doc.headings.length;
  const { root, leaves } = drawable ? buildTree(doc) : { root: null, leaves: [] as string[] };
  const colX = (c: number): number => IE_W + GAP + c * COL_W;
  const leafX = colX(n);
  const treeW = drawable ? leafX + 14 + LEAF_W : 640;
  const treeH = drawable ? leaves.length * ROW_H : 40;
  const contentW = Math.max(treeW, 640);
  const width = Math.ceil(contentW + 2 * m);

  const cur = opts.result && !opts.result.stale && opts.result.record.status === 'completed' && opts.result.record.completeness === 'complete' ? opts.result.record : null;
  const freq = new Map(cur?.sequences.map((s) => [s.key, s.frequency]) ?? []);
  const endOf = new Map(doc.sequences.map((s) => [pathKey(s.path), s.end_state]));
  const endName = (id: string): string => {
    const e = doc.end_states.find((x) => x.id === id);
    return e ? endStateLabel(short(e.name, 30), e.synthetic) : id === '' ? '(no end state)' : id;
  };

  const head = [short(doc.tree.name || 'Untitled event tree', 80), `Initiating event: ${short(doc.initiating_event.name, 60)} · ${doc.initiating_event.frequency} per year · model ${short(doc.fault_tree_model.name, 40)} · ${doc.headings.length} heading${doc.headings.length === 1 ? '' : 's'} · ${doc.sequences.length} sequence${doc.sequences.length === 1 ? '' : 's'}`];
  const headingLines = doc.headings.map((h, i) => {
    const c = h.asked_only_if;
    const when = c ? `; asked only if ${doc.headings.find((x) => x.id === c.heading)?.name ?? c.heading} ${c.branch}` : '';
    return `${i + 1}. ${h.name}: fails when ${h.event} occurs${when}.`;
  });
  const legend = 'Each heading works (upper branch) or fails (lower branch). A heading that is not asked on a path has no branch there. Each line on the right is one sequence and the end state it ends in.';
  const tooMany = drawable ? [] : [`This tree has too many sequences to draw (more than ${MAX_DRAWN_SEQUENCES}). The sequence table lists all of them.`];
  const foot = [...tooMany, ...headingLines, legend, EVENT_TREE_ASSUMPTIONS_TEXT, ...eventTreeResultLines(opts.result), `${appName}${opts.generated ? ` · ${opts.generated}` : ''}`].flatMap((t) => wrapText(t, Math.floor(contentW / CHAR_W)));

  const headH = 20 + head.length * LINE + 10;
  const top = m + headH + HEAD_H;
  const footTop = top + treeH + 24;
  const height = Math.ceil(footTop + foot.length * LINE + m);
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}">`);
  parts.push(`<title id="t">${esc(`Event tree: ${doc.tree.name || 'Untitled event tree'}`)}</title><desc id="d">${esc(`${head[1]}.`)}</desc>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#fff"/>`);
  parts.push(`<text x="${m}" y="${m + 14}" font-size="16" font-weight="bold">${esc(head[0]!)}</text>`);
  parts.push(`<text x="${m}" y="${m + 14 + LINE + 4}" font-size="11">${esc(head[1]!)}</text>`);

  if (root) {
    const g: string[] = [];
    // initiating event box, vertically centred on the root of the tree
    const rx = root.kind === 'node' ? colX(root.col) : leafX;
    g.push(`<rect x="0" y="${num(root.y - 24)}" width="${IE_W - 20}" height="48" rx="6" fill="#fff" stroke="#000" stroke-width="2"/>`);
    g.push(`<text x="${(IE_W - 20) / 2}" y="${num(root.y - 4)}" text-anchor="middle" font-size="11" font-weight="bold">${esc(short(doc.initiating_event.name, 20))}</text>`);
    g.push(`<text x="${(IE_W - 20) / 2}" y="${num(root.y + 12)}" text-anchor="middle" font-size="10">${esc(`${short(String(doc.initiating_event.frequency), 12)} per year`)}</text>`);
    g.push(`<line x1="${IE_W - 20}" y1="${num(root.y)}" x2="${num(rx)}" y2="${num(root.y)}" stroke="#000" stroke-width="1.5"/>`);
    const draw = (it: Item): void => {
      if (it.kind === 'leaf') {
        const end = endOf.get(it.key) ?? '';
        const f = freq.get(it.key);
        g.push(`<circle cx="${leafX}" cy="${num(it.y)}" r="3" fill="#000"/>`);
        g.push(`<text x="${leafX + 10}" y="${num(it.y - 3)}" font-size="11" font-weight="bold">${esc(`${it.idx + 1}. ${endName(end)}`)}</text>`);
        if (cur) g.push(`<text x="${leafX + 10}" y="${num(it.y + 12)}" font-size="10">${esc(f === undefined ? 'no value' : `${fmt(f)} per year`)}</text>`);
        else g.push(`<text x="${leafX + 10}" y="${num(it.y + 12)}" font-size="10">${esc(short(it.key.replace(/,/g, ', '), 40))}</text>`);
        return;
      }
      const x = colX(it.col);
      g.push(`<line x1="${x}" y1="${num(it.works.y)}" x2="${x}" y2="${num(it.fails.y)}" stroke="#000" stroke-width="1.5"/>`);
      for (const [branch, child] of [['works', it.works], ['fails', it.fails]] as const) {
        const cx = child.kind === 'node' ? colX(child.col) : leafX;
        g.push(`<line x1="${x}" y1="${num(child.y)}" x2="${num(cx)}" y2="${num(child.y)}" stroke="#000" stroke-width="1.5"/>`);
        g.push(`<text x="${x + 6}" y="${num(child.y - 4)}" font-size="9">${branch}</text>`);
        draw(child);
      }
    };
    draw(root);
    // column headers: the heading and its event
    doc.headings.forEach((h, i) => {
      g.push(`<text x="${colX(i)}" y="-22" text-anchor="middle" font-size="11" font-weight="bold">${esc(short(`${i + 1}. ${h.name}`, 22))}</text>`);
      g.push(`<text x="${colX(i)}" y="-9" text-anchor="middle" font-size="9">${esc(short(h.event, 24))}${h.asked_only_if ? ' *' : ''}</text>`);
    });
    parts.push(`<g transform="translate(${m} ${top})">${g.join('')}</g>`);
    if (doc.headings.some((h) => h.asked_only_if)) parts.push(`<text x="${m}" y="${top - 2 - HEAD_H + 8}" font-size="9">* asked only on some paths (see below)</text>`);
  }
  parts.push(`<line x1="${m}" y1="${footTop - 10}" x2="${width - m}" y2="${footTop - 10}" stroke="#000" stroke-width="0.75"/>`);
  foot.forEach((t, i) => parts.push(`<text x="${m}" y="${footTop + 4 + i * LINE}" font-size="11"${t.startsWith('DIAGNOSTIC') || t.startsWith('NO CURRENT') ? ' font-weight="bold"' : ''} xml:space="preserve">${esc(t)}</text>`));
  parts.push(`</svg>`);
  return parts.join('\n') + '\n';
}

/** A safe file stem for the event tree. */
export function eventTreeFileStem(doc: EtDoc, fileName: string | null): string {
  const raw = fileName ?? doc.tree.name ?? 'event-tree';
  const stem = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/[.-]+$/, '').slice(0, 64);
  return stem || 'event-tree';
}
