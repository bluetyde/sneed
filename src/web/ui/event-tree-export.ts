// Saving the event-tree drawing as a file and printing it. The figure is made by model/event-tree-figure.ts (pure text); this file hands it to
// the browser the same way exporter.ts does for fault trees. The print sheet carries the tables too, so a printed page holds every number.
import { endStateLabel } from '../../core/event-tree-result.js';
import type { EventTreeEditor } from '../model/event-tree-editor.js';
import { eventTreeFileStem } from '../model/event-tree-figure.js';
import { h } from './dom.js';
import { figurePng, save } from './exporter.js';

/** The figure, checked: it must parse as an SVG document. Throws otherwise. */
export function checkedEventTreeFigure(ed: EventTreeEditor): string {
  const svg = ed.figureSvg();
  const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (d.querySelector('parsererror') || d.documentElement.localName !== 'svg') throw new Error('the figure could not be built as a valid SVG document');
  return svg;
}

export function exportEventTreeSvg(ed: EventTreeEditor): void {
  let svg: string;
  try {
    svg = checkedEventTreeFigure(ed);
  } catch (e) {
    return ed.setNotice('error', `Could not save the SVG: ${(e as Error).message}.`);
  }
  save(`${eventTreeFileStem(ed.doc, ed.fileName)}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
  ed.setNotice('info', 'Saved the drawing as an SVG file.');
}

export async function exportEventTreePng(ed: EventTreeEditor): Promise<void> {
  try {
    save(`${eventTreeFileStem(ed.doc, ed.fileName)}.png`, await figurePng(checkedEventTreeFigure(ed)));
    ed.setNotice('info', 'Saved the drawing as a PNG file.');
  } catch (e) {
    ed.setNotice('error', `Could not save the PNG: ${(e as Error).message}. The SVG file can still be saved.`);
  }
}

const num = (p: number): string => String(p);

/** The print sheet: the drawing, then (for a current result) the sequence and end-state tables. Built only while printing. */
export function buildEventTreePrintSheet(ed: EventTreeEditor): HTMLElement {
  const sheet = h('section', { id: 'print-sheet', class: 'print-sheet', 'aria-hidden': 'true', 'data-testid': 'print-sheet' });
  try {
    sheet.append(document.importNode(new DOMParser().parseFromString(checkedEventTreeFigure(ed), 'image/svg+xml').documentElement, true));
  } catch (e) {
    sheet.append(h('p', { role: 'alert' }, `The drawing could not be printed: ${(e as Error).message}.`));
  }
  const rec = ed.currentRecord;
  if (rec) {
    const name = new Map(rec.headings.map((x) => [x.id, x.name]));
    const endName = new Map(rec.end_states.map((x) => [x.id, endStateLabel(x.name, x.synthetic)]));
    sheet.append(
      h('h2', {}, 'Sequences'),
      h('table', { class: 'sheet-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Path'), h('th', {}, 'Ends in'), h('th', {}, 'Probability of the path'), h('th', {}, 'Frequency per year'))),
        h('tbody', {}, ...rec.sequences.map((s, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, s.path.map((st) => `${name.get(st.heading) ?? st.heading} ${st.branch}`).join(', ')), h('td', {}, endName.get(s.end_state) ?? s.end_state), h('td', {}, num(s.probability)), h('td', {}, num(s.frequency)))))),
      h('h2', {}, 'End states'),
      h('table', { class: 'sheet-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'End state'), h('th', {}, 'Frequency per year'), h('th', {}, 'Share of the total'), h('th', {}, 'Sequences'))),
        h('tbody', {}, ...rec.end_states.map((x) => h('tr', {}, h('td', {}, endName.get(x.id) ?? x.id), h('td', {}, num(x.frequency)), h('td', {}, num(x.probability)), h('td', {}, String(x.sequences.length)))))),
    );
  }
  return sheet;
}
