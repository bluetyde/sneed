// Saving the drawing as a file and printing it. The figure itself is made by model/figure.ts (pure text); this file only hands it to the
// browser: a download, a PNG drawn from it, and the print sheet that `window.print()` shows (the editor itself is hidden when printing).
import { figureFileStem } from '../model/figure.js';
import type { Editor } from '../model/editor.js';
import { h } from './dom.js';

const MAX_PNG_SIDE = 8000;

function save(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The size the SVG document declares. */
export function figureSize(svg: string): { width: number; height: number } {
  const m = /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svg);
  return { width: m ? Number(m[1]) : 800, height: m ? Number(m[2]) : 600 };
}

/** The figure, checked: it must parse as an SVG document (a figure the browser cannot read is an error, not a file). Throws otherwise. */
export function checkedFigure(editor: Editor): string {
  const svg = editor.figureSvg();
  const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (d.querySelector('parsererror') || d.documentElement.localName !== 'svg') throw new Error('the figure could not be built as a valid SVG document');
  return svg;
}

export function exportSvg(editor: Editor): void {
  let svg: string;
  try {
    svg = checkedFigure(editor);
  } catch (e) {
    return editor.setNotice('error', `Could not save the SVG: ${(e as Error).message}.`);
  }
  save(`${figureFileStem(editor.doc, editor.fileName)}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
  editor.setNotice('info', 'Saved the drawing as an SVG file.');
}

/** Draws the figure at twice its size (less if that would be larger than a browser canvas can be) and returns the PNG. */
export async function figurePng(svg: string): Promise<Blob> {
  const { width, height } = figureSize(svg);
  const scale = Math.min(2, MAX_PNG_SIDE / Math.max(width, height));
  const img = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('the browser could not draw the figure'));
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('the browser has no canvas to draw on');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not make the PNG'))), 'image/png'));
}

export async function exportPng(editor: Editor): Promise<void> {
  try {
    save(`${figureFileStem(editor.doc, editor.fileName)}.png`, await figurePng(checkedFigure(editor)));
    editor.setNotice('info', 'Saved the drawing as a PNG file.');
  } catch (e) {
    editor.setNotice('error', `Could not save the PNG: ${(e as Error).message}. The SVG file can still be saved.`);
  }
}

const SHEET_CUT_SETS = 60;

/**
 * Builds the print sheet: the figure, then the minimal cut sets of a current result (a table, so it prints across pages). It exists only
 * while printing (built on `beforeprint`, removed on `afterprint`), so it never shows on the screen or to a screen reader.
 */
export function buildPrintSheet(editor: Editor): HTMLElement {
  const sheet = h('section', { id: 'print-sheet', class: 'print-sheet', 'aria-hidden': 'true', 'data-testid': 'print-sheet' });
  try {
    sheet.append(document.importNode(new DOMParser().parseFromString(checkedFigure(editor), 'image/svg+xml').documentElement, true));
  } catch (e) {
    sheet.append(h('p', { role: 'alert' }, `The drawing could not be printed: ${(e as Error).message}.`)); // a visible failure on the page, never a silently empty sheet
  }
  const r = editor.result;
  if (r?.kind === 'ran' && !editor.figureStale) {
    const sets = r.record.minimal_cut_sets;
    const ok = r.record.status === 'completed' && r.record.completeness === 'complete';
    sheet.append(
      h('h2', {}, `Minimal cut sets${ok ? '' : ' (diagnostic only)'}`),
      h('table', { class: 'sheet-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Events that must all fail'), h('th', {}, 'Probability'))),
        h('tbody', {}, ...sets.slice(0, SHEET_CUT_SETS).map((c, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, c.events.join(', ')), h('td', {}, String(c.probability)))))),
      ...(sets.length > SHEET_CUT_SETS ? [h('p', {}, `${sets.length - SHEET_CUT_SETS} more cut sets are not printed.`)] : []),
    );
  }
  return sheet;
}

/** Wires the browser's print events to the sheet, so Ctrl+P and the Print button print the same thing. */
export function installPrint(editor: Editor): void {
  window.addEventListener('beforeprint', () => {
    document.getElementById('print-sheet')?.remove();
    document.body.append(buildPrintSheet(editor));
  });
  window.addEventListener('afterprint', () => document.getElementById('print-sheet')?.remove());
}
