import { s } from './dom.js';

// 24x24 line icons. Decorative: every button that uses one also has a text label or an aria-label.
const PATHS: Record<string, string[]> = {
  new: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M12 11v6M9 14h6'],
  open: ['M3 7h6l2 2h10v10H3z'],
  save: ['M5 3h12l3 3v15H5z', 'M8 3v6h8V3', 'M8 21v-7h8v7'],
  import: ['M5 3h12l3 3v15H5z', 'M12 8v8M9 13l3 3 3-3'],
  saveas: ['M5 3h12l3 3v7', 'M8 3v6h8V3', 'M5 3v18h8', 'M17 16v6M14 19h6'],
  undo: ['M9 7 4 12l5 5', 'M4 12h10a6 6 0 0 1 0 12'],
  redo: ['M15 7l5 5-5 5', 'M20 12H10a6 6 0 0 0 0 12'],
  delete: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14', 'M10 11v6M14 11v6'],
  event: ['M12 5a7 7 0 1 0 0.01 0z'],
  and: ['M5 20V9a7 7 0 0 1 14 0v11z'],
  or: ['M5 20c3-3 3-9 0-12 4-3 10-3 14 0-3 3-3 9 0 12z'],
  vote: ['M5 20V9a7 7 0 0 1 14 0v11z', 'M9 15l2 2 4-5'],
  fit: ['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'],
  zoomin: ['M11 4a7 7 0 1 0 0.01 0z', 'M16 16l5 5', 'M8 11h6M11 8v6'],
  zoomout: ['M11 4a7 7 0 1 0 0.01 0z', 'M16 16l5 5', 'M8 11h6'],
  layout: ['M12 3v5M5 14V8h14v6M5 14v5M12 14v5M19 14v5'],
  run: ['M7 4l13 8-13 8z'],
  stop: ['M6 6h12v12H6z'],
  check: ['M5 12l5 5 9-10'],
  warn: ['M12 3l10 18H2z', 'M12 10v5M12 18v.5'],
  error: ['M12 3a9 9 0 1 0 0.01 0z', 'M9 9l6 6M15 9l-6 6'],
  info: ['M12 3a9 9 0 1 0 0.01 0z', 'M12 11v6M12 7.5v.5'],
  close: ['M6 6l12 12M18 6L6 18'],
  top: ['M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.5 7.1 18.2l.9-5.5-4-3.9 5.5-.8z'],
  plus: ['M12 5v14M5 12h14'],
  link: ['M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1', 'M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1'],
};

export function icon(name: string): SVGSVGElement {
  const svg = s('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
  for (const d of PATHS[name] ?? PATHS.info!) svg.append(s('path', { d }));
  return svg;
}
