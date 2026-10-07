// The page: title bar, ribbon, outline, drawing, side panels and status bar. It draws editor state and routes user actions
// (buttons and keyboard shortcuts) to editor commands. Panels re-render only when their own inputs changed.

import type { Engine, Method } from '../api.js';
import type { Editor } from '../model/editor.js';
import type { EventTreeEditor } from '../model/event-tree-editor.js';
import { EventTreeView } from './event-tree.js';
import { Canvas } from './canvas.js';
import { confirmDiscard, importDialog, openDialog, saveAsDialog } from './dialogs.js';
import { buildPrintSheet, exportPng, exportSvg, installPrint } from './exporter.js';
import { buildEventTreePrintSheet } from './event-tree-export.js';
import { h } from './dom.js';
import { METHOD_TEXT } from './hints.js';
import { icon } from './icons.js';
import { ComparePanel } from './compare.js';
import { LessonPanel } from './lesson.js';
import { Outline } from './outline.js';
import { ProblemsPanel } from './problems.js';
import { Properties } from './properties.js';
import { ResultsPanel } from './results.js';

type Tab = 'properties' | 'problems' | 'results' | 'compare' | 'lesson';

type Mode = 'fault-tree' | 'event-tree';

export function mountShell(root: HTMLElement, editor: Editor, eventTree?: EventTreeEditor): void {
  let tab: Tab = 'properties';
  let mode: Mode = 'fault-tree';
  const etView = eventTree ? new EventTreeView(eventTree) : null;
  const canvas = new Canvas(editor);
  const outline = new Outline(editor);
  const properties = new Properties(editor);
  const problems = new ProblemsPanel(editor);
  const results = new ResultsPanel(editor);
  const comparePanel = new ComparePanel(editor);
  const lessonPanel = new LessonPanel(editor);
  lessonPanel.confirmStart = () => confirmDiscard(editor);
  lessonPanel.onStart = () => {
    setTab('lesson');
    canvas.fit(true);
  };
  canvas.onEdit = () => {
    setTab('properties');
    properties.focusFirst();
  };

  // ---- actions ----
  const newModel = (): void => {
    if (!confirmDiscard(editor)) return;
    editor.newModel();
    canvas.fit(true);
  };
  const openModel = async (): Promise<void> => {
    if (!confirmDiscard(editor)) return;
    const name = await openDialog(editor);
    if (name && (await editor.open(name))) canvas.fit(true);
  };
  const importModel = async (): Promise<void> => {
    if (!confirmDiscard(editor)) return;
    if (await importDialog(editor)) canvas.fit(true);
  };
  const saveAs = async (): Promise<void> => {
    const name = await saveAsDialog(editor, editor.fileName ?? editor.doc.model.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[.-]+$/g, '').slice(0, 64));
    if (name) await editor.save(name);
  };
  const save = async (): Promise<void> => {
    if (!(await editor.save())) await saveAs();
  };
  const run = (): void => {
    setTab('results');
    void editor.run();
  };

  // ---- ribbon ----
  const rbtn = (action: string, iconName: string, label: string, title: string, onclick: () => void): HTMLButtonElement =>
    h('button', { class: 'rbtn', type: 'button', title, 'aria-label': title, 'data-action': action, onclick }, icon(iconName), label) as HTMLButtonElement;
  const group = (label: string, ...kids: HTMLElement[]): HTMLElement => h('div', { class: 'rgroup', role: 'group', 'aria-label': label }, h('div', { class: 'rbtns' }, ...kids), h('div', { class: 'rlabel' }, label));
  const btn = {
    new: rbtn('new', 'new', 'New', 'New model (starts from a two-event OR)', newModel),
    open: rbtn('open', 'open', 'Open', 'Open a saved model', () => void openModel()),
    save: rbtn('save', 'save', 'Save', 'Save the model (Ctrl+S)', () => void save()),
    svg: rbtn('export-svg', 'layout', 'SVG', 'Save the drawing and its result as an SVG file', () => exportSvg(editor)),
    png: rbtn('export-png', 'image', 'PNG', 'Save the drawing and its result as a PNG image', () => void exportPng(editor)),
    print: rbtn('print', 'print', 'Print', 'Print the drawing, its result and the cut sets', () => window.print()),
    import: rbtn('import', 'import', 'Import', 'Import an Open-PSA XML file as a new model', () => void importModel()),
    saveas: rbtn('saveas', 'saveas', 'Save as', 'Save under a new name', () => void saveAs()),
    undo: rbtn('undo', 'undo', 'Undo', 'Undo (Ctrl+Z)', () => editor.undo()),
    redo: rbtn('redo', 'redo', 'Redo', 'Redo (Ctrl+Y)', () => editor.redo()),
    del: rbtn('delete', 'delete', 'Delete', 'Delete the selected node (Delete)', () => editor.deleteSelected()),
    event: rbtn('add-event', 'event', 'Basic event', 'Add a basic event (attaches to the selected gate)', () => editor.addEvent()),
    and: rbtn('add-and', 'and', 'AND gate', 'Add an AND gate with two new events', () => editor.addGate('and')),
    or: rbtn('add-or', 'or', 'OR gate', 'Add an OR gate with two new events', () => editor.addGate('or')),
    vote: rbtn('add-vote', 'vote', 'K-of-N gate', 'Add a K-of-N gate (starts as 2 of 3)', () => editor.addGate('atleast')),
    fit: rbtn('fit', 'fit', 'Fit', 'Fit the whole tree in view (0)', () => canvas.fit(true)),
    zin: rbtn('zoom-in', 'zoomin', 'Zoom in', 'Zoom in (+)', () => canvas.zoomBy(1.25)),
    zout: rbtn('zoom-out', 'zoomout', 'Zoom out', 'Zoom out (-)', () => canvas.zoomBy(1 / 1.25)),
    reset: rbtn('reset-layout', 'layout', 'Auto layout', 'Forget moved positions and lay the tree out automatically', () => {
      editor.resetLayout();
      canvas.fit(true);
    }),
  };
  const ribbon = h('div', { class: 'ribbon', role: 'toolbar', 'aria-label': 'Editor tools' },
    group('File', btn.new, btn.open, btn.import, btn.save, btn.saveas),
    group('Edit', btn.undo, btn.redo, btn.del),
    group('Add', btn.event, btn.and, btn.or, btn.vote),
    group('View', btn.fit, btn.zin, btn.zout, btn.reset),
    group('Export', btn.svg, btn.png, btn.print));
  installPrint(() => (mode === 'event-tree' && eventTree ? buildEventTreePrintSheet(eventTree) : buildPrintSheet(editor)));

  // ---- title bar ----
  const docName = h('div', { class: 'doc-name', 'data-testid': 'doc-name' });
  const methodSelect = h('select', { id: 'method', 'data-testid': 'method', onchange: (e) => editor.setMethod((e.target as HTMLSelectElement).value as Method) }, ...(['exact', 'rare-event', 'mcub'] as Method[]).map((m) => h('option', { value: m }, METHOD_TEXT[m]))) as HTMLSelectElement;
  const engineSelect = h('select', { id: 'engine', 'data-testid': 'engine', onchange: (e) => editor.setEngine((e.target as HTMLSelectElement).value as Engine) },
    h('option', { value: 'builtin', title: 'The engine inside the app: nothing to install' }, 'Built-in'), h('option', { value: 'scram', title: 'The installed SCRAM runtime' }, 'SCRAM'), h('option', { value: 'both', title: 'Run both engines and say whether they agree' }, 'Both')) as HTMLSelectElement;
  const runBtn = h('button', { class: 'run', type: 'button', 'data-testid': 'run', 'aria-describedby': 'run-pill', onclick: run }, icon('run'), 'Run') as HTMLButtonElement;
  const stopBtn = h('button', { class: 'stop', type: 'button', 'data-testid': 'cancel', onclick: () => void editor.cancel() }, icon('stop'), 'Cancel') as HTMLButtonElement;
  const pill = h('span', { class: 'run-pill', id: 'run-pill', role: 'status', 'data-testid': 'run-pill' });
  const brandSub = h('small', {}, 'fault-tree editor');
  const modeBtn = (m: Mode, label: string): HTMLButtonElement => h('button', { class: 'btn', type: 'button', 'data-mode': m, 'aria-pressed': 'false', onclick: () => void setMode(m) }, label) as HTMLButtonElement;
  const modeButtons: Record<Mode, HTMLButtonElement> = { 'fault-tree': modeBtn('fault-tree', 'Fault tree'), 'event-tree': modeBtn('event-tree', 'Event tree') };
  const modeSwitch = h('div', { class: 'mode-switch', role: 'group', 'aria-label': 'What to edit', hidden: !etView }, modeButtons['fault-tree'], modeButtons['event-tree']);
  const titlebar = h('div', { class: 'titlebar' }, h('h1', { class: 'brand' }, 'SNEED', brandSub), modeSwitch, docName, h('div', { class: 'spacer' }), h('div', { class: 'run-group' }, h('label', { for: 'engine' }, 'Engine'), engineSelect, h('label', { for: 'method' }, 'Method'), methodSelect, runBtn, stopBtn, pill));

  // ---- notice ----
  const notice = h('div', { class: 'notice', role: 'status', hidden: true, 'data-testid': 'notice' });

  // ---- side panels ----
  const tabs: Record<Tab, HTMLButtonElement> = {
    properties: h('button', { class: 'stab', role: 'tab', id: 'tab-properties', 'aria-controls': 'panel-properties', 'data-tab': 'properties', onclick: () => setTab('properties') }, 'Properties') as HTMLButtonElement,
    problems: h('button', { class: 'stab', role: 'tab', id: 'tab-problems', 'aria-controls': 'panel-problems', 'data-tab': 'problems', onclick: () => setTab('problems') }) as HTMLButtonElement,
    results: h('button', { class: 'stab', role: 'tab', id: 'tab-results', 'aria-controls': 'panel-results', 'data-tab': 'results', onclick: () => setTab('results') }) as HTMLButtonElement,
    compare: h('button', { class: 'stab', role: 'tab', id: 'tab-compare', 'aria-controls': 'panel-compare', 'data-tab': 'compare', onclick: () => setTab('compare') }, 'Compare') as HTMLButtonElement,
    lesson: h('button', { class: 'stab', role: 'tab', id: 'tab-lesson', 'aria-controls': 'panel-lesson', 'data-tab': 'lesson', onclick: () => setTab('lesson') }, 'Lesson') as HTMLButtonElement,
  };
  const tablist = h('div', { class: 'stabs', role: 'tablist', 'aria-label': 'Side panels' }, tabs.properties, tabs.problems, tabs.results, tabs.compare, tabs.lesson);
  tablist.addEventListener('keydown', (e) => {
    const order: Tab[] = ['properties', 'problems', 'results', 'compare', 'lesson'];
    const i = order.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]!;
      setTab(next);
      tabs[next].focus();
    }
  });
  const panels: Record<Tab, HTMLElement> = { properties: properties.el, problems: problems.el, results: results.el, compare: comparePanel.el, lesson: lessonPanel.el };
  const side = h('aside', { class: 'side', 'aria-label': 'Details' }, tablist, properties.el, problems.el, results.el, comparePanel.el, lessonPanel.el);

  function setTab(next: Tab): void {
    if (next === 'compare' && tab !== 'compare') void editor.refreshRuns();
    tab = next;
    syncTabs();
  }
  function syncTabs(): void {
    for (const t of Object.keys(tabs) as Tab[]) {
      tabs[t].setAttribute('aria-selected', String(t === tab));
      tabs[t].tabIndex = t === tab ? 0 : -1;
      panels[t].hidden = t !== tab;
    }
  }

  // ---- status bar ----
  const status = h('footer', { class: 'status', 'data-testid': 'status' });

  const center = h('main', { class: 'center', 'aria-label': 'Drawing area' }, h('div', { class: 'canvas-bar' }, h('span', {}, 'Drag a node to move it. Drag from the dot under a gate to connect it. Arrow keys move between nodes; Enter edits.')), canvas.el);
  const mainRow = h('div', { class: 'main' }, outline.el, center, side);
  const win = h('div', { class: 'win', 'data-testid': 'win' }, h('header', { class: 'top' }, titlebar, ribbon, notice), mainRow, ...(etView ? [etView.el] : []), status);
  root.replaceChildren(win);
  root.removeAttribute('class');
  root.classList.add('app');

  async function setMode(next: Mode): Promise<void> {
    if (next === mode || !etView || !eventTree) return;
    mode = next;
    if (mode === 'event-tree') await eventTree.refreshContext(); // the saved models may have changed in the other view
    renderAll();
  }
  const runGroup = titlebar.querySelector<HTMLElement>('.run-group')!;

  // ---- render ----
  let queued = false;
  let lastSelected: string | null = null;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    // a timer, not requestAnimationFrame: frames are not delivered to a hidden or background page, and the editor must stay current
    setTimeout(() => {
      queued = false;
      renderAll();
    }, 0);
  };

  function renderEventTreeMode(): void {
    const et = eventTree!;
    docName.replaceChildren(h('b', {}, et.doc.tree.name), ` · ${et.fileName ?? 'not saved yet'}`, et.dirty ? h('span', { class: 'dirty', role: 'img', 'aria-label': 'unsaved changes', 'data-testid': 'et-dirty' }, ' ●') : '');
    document.title = `${et.dirty ? '• ' : ''}${et.doc.tree.name} · SNEED`;
    win.dataset.dirty = String(et.dirty);
    win.dataset.valid = et.validation === null ? 'unknown' : String(et.validation.valid);
    win.dataset.running = String(et.running);
    notice.hidden = et.notice === null;
    notice.className = `notice ${et.notice?.kind ?? 'info'}`;
    notice.replaceChildren(h('span', {}, et.notice?.text ?? ''), h('button', { type: 'button', 'aria-label': 'Dismiss this message', onclick: () => et.setNotice(null) }, 'Dismiss'));
    etView!.render();
    const v = et.validation;
    status.replaceChildren(
      h('span', {}, 'Event tree hash ', h('code', { 'data-testid': 'et-hash', 'data-hash': v?.tree_hash ?? '' }, v?.tree_hash ? v.tree_hash.slice(0, 12) : 'none')),
      h('span', { 'data-testid': 'et-validation-state' }, v === null ? 'checking…' : v.valid ? (v.warnings.length ? `valid, ${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}` : 'valid') : `${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}`),
      h('span', {}, `model ${et.doc.fault_tree_model.name}`),
      h('span', { class: 'spacer' }),
      h('span', {}, `${et.doc.headings.length} headings · ${et.doc.sequences.length} sequences · ${et.doc.end_states.length} end states`));
  }

  function renderAll(): void {
    const ed = editor;
    for (const m of Object.keys(modeButtons) as Mode[]) modeButtons[m].setAttribute('aria-pressed', String(m === mode));
    const et = mode === 'event-tree';
    ribbon.hidden = et;
    runGroup.hidden = et;
    mainRow.hidden = et;
    if (etView) etView.el.hidden = !et;
    brandSub.textContent = et ? 'event-tree editor' : 'fault-tree editor';
    if (et) return renderEventTreeMode();
    const v = ed.validation;
    // title
    docName.replaceChildren(h('b', {}, ed.doc.model.name), ` · ${ed.fileName ?? 'not saved yet'}`, ed.dirty ? h('span', { class: 'dirty', role: 'img', 'aria-label': 'unsaved changes', 'data-testid': 'dirty' }, ' ●') : '');
    document.title = `${ed.dirty ? '• ' : ''}${ed.doc.model.name} · SNEED`;
    win.dataset.dirty = String(ed.dirty);
    win.dataset.valid = v === null ? 'unknown' : String(v.valid);
    win.dataset.running = String(ed.running);
    // ribbon state
    btn.undo.disabled = !ed.canUndo;
    btn.redo.disabled = !ed.canRedo;
    btn.undo.title = btn.undo.ariaLabel = ed.undoLabel ? `Undo: ${ed.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    btn.redo.title = btn.redo.ariaLabel = ed.redoLabel ? `Redo: ${ed.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    btn.del.disabled = !ed.selected;
    // run controls
    methodSelect.value = ed.method;
    methodSelect.disabled = ed.running;
    engineSelect.value = ed.engine;
    engineSelect.disabled = ed.running;
    runBtn.disabled = !ed.canRun;
    runBtn.hidden = ed.running;
    stopBtn.hidden = !ed.running;
    const blocked = ed.runBlockedReason;
    let pillText = 'Ready to run';
    let pillClass = 'ok';
    if (ed.running) [pillText, pillClass] = [ed.queueAhead > 0 ? `Waiting for ${ed.queueAhead} other run${ed.queueAhead === 1 ? '' : 's'}…` : 'Running…', 'warn'];
    else if (ed.reuseOffer) [pillText, pillClass] = ['A saved result for this run exists', 'ok'];
    else if (blocked) [pillText, pillClass] = [`Run blocked: ${blocked}`, 'blocked'];
    else if (ed.result?.kind === 'ran') [pillText, pillClass] = ed.stale ? ['Result out of date', 'warn'] : ['Result is current', 'ok'];
    pill.textContent = pillText;
    pill.className = `run-pill ${pillClass}`;
    pill.title = blocked ?? '';
    // notice
    notice.hidden = ed.notice === null;
    notice.className = `notice ${ed.notice?.kind ?? 'info'}`;
    notice.replaceChildren(h('span', {}, ed.notice?.text ?? ''), h('button', { type: 'button', 'aria-label': 'Dismiss this message', onclick: () => ed.setNotice(null) }, 'Dismiss'));
    // tabs
    const errs = ed.errorCount;
    const warns = v?.warnings.length ?? 0;
    tabs.problems.replaceChildren('Problems', errs || warns ? h('span', { class: `count ${errs ? 'err' : 'warn'}`, 'data-testid': 'problem-count' }, String(errs || warns)) : '');
    tabs.problems.setAttribute('aria-label', `Problems, ${errs} to fix, ${warns} warnings`);
    tabs.results.replaceChildren('Results', ed.result?.kind === 'ran' && ed.stale ? h('span', { class: 'count warn', title: 'out of date' }, 'old') : '');
    const lp = ed.lessonProgress;
    tabs.lesson.replaceChildren('Lesson', lp?.complete ? h('span', { class: 'count ok', 'data-testid': 'lesson-tab-complete' }, 'done') : '');
    // selecting a node while looking at results shows its properties
    if (ed.selected !== lastSelected) {
      if (ed.selected && tab === 'results') setTab('properties');
      lastSelected = ed.selected;
    }
    syncTabs();
    outline.render();
    canvas.render();
    properties.render();
    problems.render();
    results.render();
    comparePanel.render();
    lessonPanel.render();
    // status
    const hash = v?.model_hash ?? null;
    const rt = ed.runtime;
    status.replaceChildren(
      h('span', {}, 'Model hash ', h('code', { 'data-testid': 'model-hash', 'data-hash': hash ?? '' }, hash ? hash.slice(0, 12) : 'none')),
      h('span', { 'data-testid': 'validation-state' }, v === null ? 'checking…' : v.valid ? (v.warnings.length ? `valid, ${v.warnings.length} warning${v.warnings.length === 1 ? '' : 's'}` : 'valid') : `${errs} problem${errs === 1 ? '' : 's'}`),
      h('span', { 'data-testid': 'runtime-state' }, rt === null ? 'runtime: checking…' : rt.installed ? `SCRAM ${rt.engine_version ?? ''} · install ${rt.install_id ?? '?'}` : 'SCRAM runtime not installed'),
      h('span', {}, ed.selected ? `Selected ${ed.selectedId}` : 'Nothing selected'),
      h('span', { class: 'spacer' }),
      h('span', {}, `${ed.visual.nodes.length} drawn · ${ed.doc.events.length} events · ${ed.doc.gates.length} gates`));
  }

  editor.subscribe(schedule);
  eventTree?.subscribe(schedule);

  // ---- keyboard ----
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
    const mod = e.ctrlKey || e.metaKey;
    if (document.querySelector('dialog[open]')) return;
    if (mode === 'event-tree' && eventTree && etView) {
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void etView.save();
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        etView.flush();
        if (eventTree.canRun) void eventTree.run();
      } else if (e.key === 'Escape' && !typing && eventTree.running) void eventTree.cancel();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      if (editor.canRun) run();
    } else if (mod && !typing && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      editor.undo();
    } else if (mod && !typing && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      editor.redo();
    } else if (e.key === 'Escape' && !typing) {
      if (editor.running) void editor.cancel();
      else if (editor.highlight.length) editor.clearExplain();
      else editor.select(null);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (editor.dirty || eventTree?.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  renderAll();
  canvas.fit(true);
  void editor.loadHealth();
  void editor.refreshModels();
  void editor.loadLessons();
  void editor.refreshRuns();
}
