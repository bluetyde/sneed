// Tiny element builders. No framework: the editor re-renders small panels and rebuilds the SVG drawing on change.

type Attr = string | number | boolean | null | undefined | ((e: Event) => void);
export type Attrs = Record<string, Attr>;
export type Child = Node | string | number | null | undefined | false | Child[];

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}
function append(el: Element, kids: Child[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, kids);
  return el;
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, kids);
  return el;
}

/** Replaces a container's children and, if a field inside had focus, puts focus back on the same field afterwards. */
export function rerender(container: HTMLElement, build: () => Child[]): void {
  const active = document.activeElement as HTMLElement | null;
  const field = active && container.contains(active) ? active.getAttribute('data-field') : null;
  const selStart = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  container.replaceChildren();
  append(container, build());
  if (field) {
    const again = container.querySelector<HTMLElement>(`[data-field="${field}"]`);
    again?.focus();
    if (again instanceof HTMLInputElement && selStart !== null && again.type === 'text') again.setSelectionRange(selStart, selStart);
  }
}
