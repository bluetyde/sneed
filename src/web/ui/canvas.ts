// The drawing of the fault tree: an SVG with pan and zoom, selectable and draggable nodes, drag-to-connect from a gate's
// port, and full keyboard operation. It draws editor state and calls editor commands; it keeps only view state itself.

import { findEvent, findGate, groupOf, groups } from '../model/doc.js';
import type { Editor } from '../model/editor.js';
import { neighbor, type Direction, type Visual, type VisualNode } from '../model/visual.js';
import { h, s } from './dom.js';

const MIN_SCALE = 0.25;
const MAX_SCALE = 2.2;
const DRAG_THRESHOLD = 4;

interface Drag {
  kind: 'node' | 'pan' | 'connect';
  startX: number;
  startY: number;
  moved: boolean;
  key?: string;
  originX?: number;
  originY?: number;
  fromGate?: string;
  tx?: number;
  ty?: number;
}

const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class Canvas {
  readonly el: HTMLElement;
  /** Called when Enter is pressed on a node: the shell moves focus to the properties panel. */
  onEdit: () => void = () => undefined;
  private readonly svg: SVGSVGElement;
  private readonly viewport: SVGGElement;
  private readonly empty: HTMLElement;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private touched = false;
  private drag: Drag | null = null;
  private connectLine: SVGLineElement | null = null;
  private edgeEls = new Map<string, SVGPathElement>();
  private nodeEls = new Map<string, SVGGElement>();
  private lastDocKey = '';

  constructor(private readonly editor: Editor) {
    this.viewport = s('g', { class: 'viewport' });
    this.svg = s('svg', { class: 'canvas', role: 'group', 'aria-label': 'Fault tree drawing', 'data-testid': 'canvas' }, this.viewport);
    this.empty = h('div', { class: 'canvas-empty', hidden: true }, 'Nothing to draw yet. Add a basic event or a gate from the ribbon.');
    this.el = h('div', { class: 'canvas-wrap' }, this.svg, this.empty);
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointercancel', () => this.endDrag());
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => {
      if (!this.touched) this.fit();
    }).observe(this.el);
  }

  // ---- view ----
  private applyView(): void {
    this.viewport.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.scale})`);
    this.el.dataset.scale = this.scale.toFixed(3);
  }
  fit(userAction = false): void {
    const r = this.svg.getBoundingClientRect();
    const b = this.editor.visual.bounds;
    if (userAction) this.touched = false;
    if (r.width < 10 || r.height < 10 || this.editor.visual.nodes.length === 0) return;
    const pad = 40;
    const sc = Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1), 1.25);
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, sc));
    this.tx = (r.width - b.w * this.scale) / 2 - b.x * this.scale;
    this.ty = (r.height - b.h * this.scale) / 2 - b.y * this.scale;
    this.applyView();
  }
  zoomBy(factor: number, cx?: number, cy?: number): void {
    const r = this.svg.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
    this.touched = true;
    this.applyView();
  }
  private toWorld(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.tx) / this.scale, y: (e.clientY - r.top - this.ty) / this.scale };
  }

  // ---- drawing ----
  render(): void {
    const ed = this.editor;
    const v = ed.visual;
    const hadFocus = this.svg.contains(document.activeElement);
    const focusedKey = hadFocus ? (document.activeElement as Element).closest('.node')?.getAttribute('data-key') : null;
    const problems = new Map<string, 'error' | 'warning'>();
    for (const p of ed.problems) for (const id of p.ids ?? []) if (problems.get(id) !== 'error') problems.set(id, p.severity);
    const highlighted = new Set(ed.highlight);
    const selectedId = ed.selectedId;

    this.viewport.replaceChildren();
    this.edgeEls.clear();
    this.nodeEls.clear();
    const edgeLayer = s('g', { class: 'edges' });
    const nodeLayer = s('g', { class: 'nodes' });
    const groupLayer = s('g', { class: 'groups' });
    this.viewport.append(groupLayer, edgeLayer, nodeLayer);
    for (const box of this.groupBoxes(v)) groupLayer.append(box);

    for (const e of v.edges) {
      const from = v.byKey.get(e.from)!;
      const to = v.byKey.get(e.to)!;
      const path = s('path', { class: `edge${to.kind !== 'event' && to.kind !== 'gate' ? ' ref' : ''}${highlighted.has(to.id) && highlighted.has(from.id) ? ' hl' : ''}`, d: this.edgePath(from, to), 'aria-hidden': 'true' });
      this.edgeEls.set(`${e.from}>${e.to}`, path);
      edgeLayer.append(path);
    }

    const order = [...v.nodes];
    const tabKey = ed.selected && v.byKey.has(ed.selected) ? ed.selected : (order[0]?.key ?? null);
    for (const n of order) {
      const el = this.nodeEl(n, v, problems, highlighted, selectedId, n.key === tabKey);
      this.nodeEls.set(n.key, el);
      nodeLayer.append(el);
    }

    this.empty.hidden = v.nodes.length > 0;
    const sig = `${v.nodes.length}:${v.bounds.w}:${ed.doc.model.id}:${ed.fileName ?? ''}`;
    if (!this.touched && sig !== this.lastDocKey) this.fit();
    this.lastDocKey = sig;
    this.applyView();
    if (focusedKey && this.nodeEls.has(focusedKey)) this.nodeEls.get(focusedKey)!.focus({ preventScroll: true });
  }

  /**
   * A box behind the members of each common-cause group, with the group's name and beta (plan 15). The members are marked on their own nodes too,
   * because a box around members that are far apart also covers other nodes: the mark on the node, not the box, says who belongs.
   */
  private groupBoxes(v: Visual): SVGGElement[] {
    const ed = this.editor;
    const out: SVGGElement[] = [];
    for (const grp of groups(ed.doc)) {
      const members = v.nodes.filter((n) => n.kind === 'event' && grp.members.includes(n.id));
      if (members.length === 0) continue;
      const x1 = Math.min(...members.map((n) => n.x - n.w / 2)) - 16;
      const y1 = Math.min(...members.map((n) => n.y - n.h / 2)) - 30;
      const x2 = Math.max(...members.map((n) => n.x + n.w / 2)) + 16;
      const y2 = Math.max(...members.map((n) => n.y + n.h / 2)) + 14;
      const selected = ed.selectedGroup === grp.id;
      const label = ed.groupLabel(grp.id);
      const el = s('g', { class: `ccgroup${selected ? ' selected' : ''}`, 'data-group': grp.id, role: 'button', tabindex: -1, 'aria-pressed': selected ? 'true' : 'false', 'aria-label': `Common-cause group ${label}, ${grp.members.length} basic events that can fail together, beta ${grp.beta}` });
      el.append(s('rect', { class: 'box', x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 14 }));
      el.append(s('rect', { class: 'bar', x: x1, y: y1, width: x2 - x1, height: 22, rx: 14 }));
      el.append(s('text', { class: 't-group', x: x1 + 12, y: y1 + 15 }, short(`${label} · beta ${grp.beta}`, Math.max(12, Math.floor((x2 - x1) / 7)))));
      out.push(el);
    }
    return out;
  }

  private edgePath(from: VisualNode, to: VisualNode): string {
    const x1 = from.x;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y - to.h / 2;
    const dy = Math.max(24, Math.abs(y2 - y1) / 2);
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }

  private nodeEl(n: VisualNode, v: Visual, problems: Map<string, 'error' | 'warning'>, highlighted: Set<string>, selectedId: string | null, tab: boolean): SVGGElement {
    const ed = this.editor;
    const doc = ed.doc;
    const sev = problems.get(n.id);
    const isTop = doc.top === n.id && (n.kind === 'event' || n.kind === 'gate');
    const selected = ed.selected === n.key;
    const sibling = !selected && selectedId === n.id;
    const gate = n.kind === 'gate' ? findGate(doc, n.id) : undefined;
    const event = n.kind === 'event' ? findEvent(doc, n.id) : undefined;
    const name = (gate ?? event ?? findGate(doc, n.id) ?? findEvent(doc, n.id))?.name;

    let line1 = n.id;
    let line2 = '';
    let label = '';
    if (n.kind === 'event') {
      line2 = `p = ${event ? event.probability : '?'}`;
      label = `Basic event ${n.id}${name ? `, ${name}` : ''}, probability ${event?.probability}`;
    } else if (n.kind === 'gate' && gate) {
      const count = gate.inputs.length;
      const type = gate.type === 'atleast' ? `${gate.threshold ?? 'K'} of ${count}` : gate.type.toUpperCase();
      line1 = `${n.id} · ${type}`;
      line2 = name ? short(name, 18) : `${count} input${count === 1 ? '' : 's'}`;
      label = `${gate.type === 'atleast' ? 'K-of-N' : gate.type.toUpperCase()} gate ${n.id}${name ? `, ${name}` : ''}, ${count} input${count === 1 ? '' : 's'}${gate.type === 'atleast' ? `, ${gate.threshold ?? 'no'} of ${count} must fail` : ''}`;
    } else if (n.kind === 'reference') {
      line1 = `↪ ${n.id}`;
      label = `Repeated reference to ${n.targetKind} ${n.id}: the same ${n.targetKind}, not a copy`;
    } else {
      line1 = `? ${n.id}`;
      label = `Reference to ${n.id}, which does not exist`;
    }
    if (name && n.kind === 'event') line1 = `${n.id} ${short(name, 13)}`;
    const memberOf = n.kind === 'event' || n.kind === 'reference' ? groupOf(doc, n.id) : undefined;
    if (memberOf) label += `, in common-cause group ${ed.groupLabel(memberOf.id)}`;
    if (isTop) label += ', top event';
    if (sev) label += sev === 'error' ? ', has a problem to fix' : ', has a warning';

    const classes = ['node', n.kind, selected ? 'selected' : '', sibling ? 'sibling' : '', highlighted.has(n.id) ? 'hl' : '', sev === 'error' ? 'err' : sev === 'warning' ? 'warn' : ''].filter(Boolean).join(' ');
    const g = s('g', { class: classes, transform: `translate(${n.x} ${n.y})`, 'data-key': n.key, 'data-id': n.id, 'data-kind': n.kind, role: 'button', tabindex: tab ? 0 : -1, 'aria-label': label, 'aria-pressed': selected ? 'true' : 'false' });
    const hw = n.w / 2;
    const hh = n.h / 2;
    g.append(s('rect', { class: 'ring', x: -hw - 5, y: -hh - 5, width: n.w + 10, height: n.h + 10, rx: 14 }));
    if (n.kind === 'event') g.append(s('ellipse', { class: 'shape', rx: hw, ry: hh }));
    else g.append(s('rect', { class: 'shape', x: -hw, y: -hh, width: n.w, height: n.h, rx: n.kind === 'gate' ? 10 : 8 }));

    if (n.kind === 'reference' || n.kind === 'missing') g.append(s('text', { class: 't-id', x: 0, y: 4, 'text-anchor': 'middle' }, line1));
    else {
      g.append(s('text', { class: 't-id', x: 0, y: -3, 'text-anchor': 'middle' }, short(line1, 20)));
      g.append(s('text', { class: 't-sub', x: 0, y: 15, 'text-anchor': 'middle' }, line2));
    }
    if (isTop) {
      g.append(s('rect', { class: 'badge-top', x: -hw + 2, y: -hh - 9, width: 34, height: 16, rx: 8 }));
      g.append(s('text', { class: 't-top', x: -hw + 19, y: -hh + 3, 'text-anchor': 'middle' }, 'TOP'));
    }
    if (memberOf && n.kind === 'event') {
      const tag = short(ed.groupLabel(memberOf.id), 10);
      const w = 14 + tag.length * 6.4;
      g.append(s('rect', { class: 'badge-cc', x: -w / 2, y: hh - 9, width: w, height: 16, rx: 8 }));
      g.append(s('text', { class: 't-cc', x: 0, y: hh + 3, 'text-anchor': 'middle' }, tag));
    }
    if (sev) {
      g.append(s('circle', { class: sev === 'error' ? 'badge-err' : 'badge-warn', cx: hw - 4, cy: -hh + 2, r: 9 }));
      g.append(s('text', { class: 't-badge', x: hw - 4, y: -hh + 6.5, 'text-anchor': 'middle' }, '!'));
    }
    if (n.kind === 'gate') g.append(s('circle', { class: 'port', cx: 0, cy: hh, r: 7, 'data-port': n.key, 'aria-hidden': 'true' }));
    void v;
    return g;
  }

  // ---- pointer ----
  private keyAt(target: EventTarget | null): string | null {
    return (target as Element | null)?.closest?.('.node')?.getAttribute('data-key') ?? null;
  }
  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const port = (e.target as Element).closest('.port');
    const key = this.keyAt(e.target);
    const group = key ? null : (e.target as Element).closest?.('.ccgroup')?.getAttribute('data-group');
    if (group) {
      this.editor.selectGroup(group);
      return;
    }
    this.svg.setPointerCapture(e.pointerId);
    if (port && key) {
      this.editor.select(key);
      this.drag = { kind: 'connect', startX: e.clientX, startY: e.clientY, moved: false, fromGate: this.editor.visual.byKey.get(key)!.id, key };
    } else if (key) {
      const n = this.editor.visual.byKey.get(key)!;
      this.editor.select(key);
      this.drag = { kind: 'node', startX: e.clientX, startY: e.clientY, moved: false, key, originX: n.x, originY: n.y };
    } else {
      this.editor.select(null);
      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, moved: false, tx: this.tx, ty: this.ty };
      this.svg.classList.add('panning');
    }
  }
  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    if (d.kind === 'pan') {
      this.tx = d.tx! + dx;
      this.ty = d.ty! + dy;
      this.touched = true;
      this.applyView();
    } else if (d.kind === 'node') {
      const v = this.editor.visual;
      const n = v.byKey.get(d.key!);
      const el = this.nodeEls.get(d.key!);
      if (!n || !el) return;
      n.x = d.originX! + dx / this.scale;
      n.y = d.originY! + dy / this.scale;
      el.setAttribute('transform', `translate(${n.x} ${n.y})`);
      for (const edge of v.edges) {
        if (edge.from === d.key || edge.to === d.key) this.edgeEls.get(`${edge.from}>${edge.to}`)?.setAttribute('d', this.edgePath(v.byKey.get(edge.from)!, v.byKey.get(edge.to)!));
      }
    } else {
      const from = this.editor.visual.byKey.get(d.key!)!;
      const p = this.toWorld(e);
      if (!this.connectLine) {
        this.connectLine = s('line', { class: 'connect-line', 'aria-hidden': 'true' });
        this.viewport.append(this.connectLine);
      }
      this.connectLine.setAttribute('x1', String(from.x));
      this.connectLine.setAttribute('y1', String(from.y + from.h / 2));
      this.connectLine.setAttribute('x2', String(p.x));
      this.connectLine.setAttribute('y2', String(p.y));
      const over = this.nodeKeyAt(e);
      for (const [k, el] of this.nodeEls) el.classList.toggle('connect-target', k === over && over !== d.key);
    }
  }
  private nodeKeyAt(e: PointerEvent): string | null {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const k = el.closest?.('.node')?.getAttribute('data-key');
      if (k) return k;
    }
    return null;
  }
  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    this.svg.classList.remove('panning');
    this.connectLine?.remove();
    this.connectLine = null;
    if (d.kind === 'node' && d.moved) {
      const n = this.editor.visual.byKey.get(d.key!);
      if (n) this.editor.moveNode(d.key!, n.x, n.y);
    } else if (d.kind === 'connect' && d.moved) {
      const target = this.nodeKeyAt(e);
      const node = target ? this.editor.visual.byKey.get(target) : undefined;
      if (node && target !== d.key) this.editor.connect(d.fromGate!, node.id);
      else this.render(); // nothing connected: clear the highlight
    }
    if (d.kind === 'node') this.nodeEls.get(d.key!)?.focus({ preventScroll: true });
  }
  private endDrag(): void {
    const d = this.drag;
    if (d?.kind === 'node') {
      // a cancelled drag must not leave the cached drawing displaced
      const n = this.editor.visual.byKey.get(d.key!);
      if (n) {
        n.x = d.originX!;
        n.y = d.originY!;
      }
    }
    this.drag = null;
    this.svg.classList.remove('panning');
    this.connectLine?.remove();
    this.connectLine = null;
    this.render();
  }
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }

  // ---- keyboard ----
  private onKey(e: KeyboardEvent): void {
    const key = this.keyAt(e.target);
    const dirs: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (key && dirs[e.key]) {
      const next = neighbor(this.editor.visual, key, dirs[e.key]!);
      e.preventDefault();
      if (next) {
        this.editor.select(next);
        this.focusNode(next);
      }
    } else if (key && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.editor.select(key);
      if (e.key === 'Enter') this.onEdit();
    } else if (key && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      this.editor.select(key);
      this.editor.deleteSelected();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.zoomBy(1.2);
    } else if (e.key === '-') {
      e.preventDefault();
      this.zoomBy(1 / 1.2);
    } else if (e.key === '0') {
      e.preventDefault();
      this.fit(true);
    } else if (key && e.key === 'Home') {
      e.preventDefault();
      const first = this.editor.visual.roots[0];
      if (first) {
        this.editor.select(first);
        this.focusNode(first);
      }
    }
  }
  focusNode(key: string): void {
    // roving tabindex: the focused node is the one Tab will return to
    for (const [k, el] of this.nodeEls) el.setAttribute('tabindex', k === key ? '0' : '-1');
    this.nodeEls.get(key)?.focus({ preventScroll: true });
  }
}
