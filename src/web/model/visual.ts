// The drawn form of a document: a tree of visual nodes. Each event or gate is drawn once (the primary node); every
// further occurrence of the same id becomes a repeated-reference node pointing at it, so one failure cannot be mistaken
// for two. Positions come from a tidy automatic layout unless the student has moved a node (stored in `layout`).

import { type Doc, findGate, isEvent, isGate } from './doc.js';

export const NODE_W = 132;
export const NODE_H = 60;
export const REF_W = 92;
export const REF_H = 34;
const H_GAP = 28;
const LEVEL_H = 112;
const ROOT_GAP = 56;

export type VisualKind = 'event' | 'gate' | 'reference' | 'missing';

export interface VisualNode {
  /** Unique in the drawing: the id for a primary node, `<parentId>#<slot>` for a reference or missing node. */
  key: string;
  kind: VisualKind;
  /** The event or gate this node stands for (for a reference, the node it points at). */
  id: string;
  /** For a reference: whether the target is an event or a gate. */
  targetKind?: 'event' | 'gate';
  parent: string | null;
  slot: number;
  /** Primary nodes of an unattached tree start a new root. */
  root: boolean;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the position came from the stored layout, not the automatic one. */
  placed: boolean;
}

export interface VisualEdge {
  from: string;
  to: string;
  slot: number;
}

export interface Visual {
  nodes: VisualNode[];
  edges: VisualEdge[];
  byKey: Map<string, VisualNode>;
  /** Keys of the roots in drawing order: the top tree first, then unattached trees. */
  roots: string[];
  bounds: { x: number; y: number; w: number; h: number };
}

interface Draft {
  node: VisualNode;
  children: Draft[];
  width: number;
}

export function buildVisual(doc: Doc): Visual {
  const placed = new Set<string>();
  const drafts: Draft[] = [];
  const edges: VisualEdge[] = [];
  const byKey = new Map<string, VisualNode>();
  const stored = new Map((doc.layout?.nodes ?? []).map((n) => [n.id, n]));
  const storedRefs = new Map((doc.layout?.references ?? []).map((r) => [r.node, r]));

  const make = (partial: Pick<VisualNode, 'key' | 'kind' | 'id' | 'parent' | 'slot' | 'depth' | 'root'> & { targetKind?: 'event' | 'gate' }): VisualNode => {
    const small = partial.kind === 'reference' || partial.kind === 'missing';
    const node: VisualNode = { ...partial, x: 0, y: 0, w: small ? REF_W : NODE_W, h: small ? REF_H : NODE_H, placed: false };
    byKey.set(node.key, node);
    return node;
  };

  const visit = (id: string, parent: Draft | null, slot: number, depth: number, root: boolean): Draft => {
    const exists = isGate(doc, id) || isEvent(doc, id);
    const parentKey = parent?.node.key ?? null;
    let draft: Draft;
    if (!exists) {
      draft = { node: make({ key: `${parentKey ?? 'root'}#${slot}`, kind: 'missing', id, parent: parentKey, slot, depth, root }), children: [], width: REF_W + H_GAP };
    } else if (placed.has(id)) {
      draft = {
        node: make({ key: `${parentKey ?? 'root'}#${slot}`, kind: 'reference', id, targetKind: isGate(doc, id) ? 'gate' : 'event', parent: parentKey, slot, depth, root }),
        children: [],
        width: REF_W + H_GAP,
      };
    } else {
      placed.add(id);
      const gate = findGate(doc, id);
      draft = { node: make({ key: id, kind: gate ? 'gate' : 'event', id, parent: parentKey, slot, depth, root }), children: [], width: NODE_W + H_GAP };
      if (gate) {
        gate.inputs.forEach((input, i) => {
          const child = visit(input, draft, i, depth + 1, false);
          draft.children.push(child);
          edges.push({ from: draft.node.key, to: child.node.key, slot: i });
        });
        const span = draft.children.reduce((sum, c) => sum + c.width, 0);
        draft.width = Math.max(draft.width, span);
      }
    }
    drafts.push(draft);
    return draft;
  };

  const rootDrafts: Draft[] = [];
  if (doc.top && (isGate(doc, doc.top) || isEvent(doc, doc.top))) rootDrafts.push(visit(doc.top, null, 0, 0, true));
  // unattached trees: gates first (so their children are drawn under them), then loose events
  for (const g of doc.gates) if (!placed.has(g.id)) rootDrafts.push(visit(g.id, null, 0, 0, true));
  for (const e of doc.events) if (!placed.has(e.id)) rootDrafts.push(visit(e.id, null, 0, 0, true));

  // tidy layout: each subtree owns a horizontal span; a parent is centred over its children
  const place = (d: Draft, left: number): void => {
    const n = d.node;
    n.y = n.depth * LEVEL_H;
    if (d.children.length === 0) {
      n.x = left + d.width / 2;
      return;
    }
    const span = d.children.reduce((sum, c) => sum + c.width, 0);
    let x = left + (d.width - span) / 2;
    for (const c of d.children) {
      place(c, x);
      x += c.width;
    }
    const first = d.children[0]!.node;
    const last = d.children[d.children.length - 1]!.node;
    n.x = (first.x + last.x) / 2;
  };
  let cursor = 0;
  for (const r of rootDrafts) {
    place(r, cursor);
    cursor += r.width + ROOT_GAP;
  }

  // stored positions win over the automatic ones
  for (const n of byKey.values()) {
    const s = n.kind === 'event' || n.kind === 'gate' ? stored.get(n.id) : storedRefs.get(n.key);
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      n.x = s.x;
      n.y = s.y;
      n.placed = true;
    }
  }

  const nodes = [...byKey.values()];
  const minX = Math.min(...nodes.map((n) => n.x - n.w / 2), 0);
  const minY = Math.min(...nodes.map((n) => n.y - n.h / 2), 0);
  const maxX = Math.max(...nodes.map((n) => n.x + n.w / 2), 0);
  const maxY = Math.max(...nodes.map((n) => n.y + n.h / 2), 0);
  return { nodes, edges, byKey, roots: rootDrafts.map((r) => r.node.key), bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/** Every visual node that stands for an id: the primary one and all its repeated references. */
export function keysFor(v: Visual, id: string): string[] {
  return v.nodes.filter((n) => n.id === id).map((n) => n.key);
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Keyboard navigation over the drawing: up to the parent, down to the first input, left and right between siblings. */
export function neighbor(v: Visual, key: string, dir: Direction): string | null {
  const n = v.byKey.get(key);
  if (!n) return null;
  if (dir === 'up') return n.parent;
  const siblings = n.parent ? v.edges.filter((e) => e.from === n.parent).sort((a, b) => a.slot - b.slot).map((e) => e.to) : v.roots;
  if (dir === 'down') return v.edges.filter((e) => e.from === key).sort((a, b) => a.slot - b.slot)[0]?.to ?? null;
  const i = siblings.indexOf(key);
  return dir === 'left' ? siblings[i - 1] ?? null : siblings[i + 1] ?? null;
}

/** All keys in a stable reading order (top tree first, depth first), for Tab-style navigation. */
export function readingOrder(v: Visual): string[] {
  const out: string[] = [];
  const walk = (key: string): void => {
    out.push(key);
    for (const e of v.edges.filter((x) => x.from === key).sort((a, b) => a.slot - b.slot)) walk(e.to);
  };
  for (const r of v.roots) walk(r);
  return out;
}
