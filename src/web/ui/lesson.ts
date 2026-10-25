// The Lesson tab: pick a lesson, then follow its steps beside the drawing. Progress comes from the lesson checker and the
// engine result; nothing here looks at where a node is drawn. State is conveyed in words, never by colour alone.

import type { Editor } from '../model/editor.js';
import { h, rerender, type Child } from './dom.js';
import { icon } from './icons.js';

export class LessonPanel {
  readonly el = h('div', { class: 'spanel', id: 'panel-lesson', role: 'tabpanel', 'aria-labelledby': 'tab-lesson', 'data-testid': 'lesson' });
  private signature = '';
  /** Asked before a lesson replaces the model on the screen; set by the shell. */
  confirmStart: () => boolean = () => true;
  onStart: () => void = () => undefined;

  constructor(private readonly editor: Editor) {}

  render(): void {
    const ed = this.editor;
    const sig = JSON.stringify([ed.lessons.map((l) => l.id), ed.lesson?.id, ed.lessonProgress, ed.calcShown, ed.hasTried, ed.stale]);
    if (sig === this.signature) return;
    this.signature = sig;
    rerender(this.el, () => (ed.lesson ? this.active() : this.list()));
  }

  private list(): Child[] {
    const ed = this.editor;
    if (ed.lessons.length === 0) return [h('p', { class: 'empty-state', 'data-testid': 'no-lessons' }, 'No lessons are available.')];
    return [
      h('p', { class: 'hint' }, 'Short guided exercises. Every number is made up for teaching and describes no real plant. Starting a lesson replaces the model on the screen.'),
      h('ol', { class: 'lessons', 'aria-label': 'Lessons' },
        ...ed.lessons.map((l) =>
          h('li', {},
            h('h2', {}, l.title),
            h('ul', { class: 'goals' }, ...l.goals.map((g) => h('li', {}, g))),
            h('button', { class: 'btn', type: 'button', 'data-testid': 'start-lesson', 'data-lesson': l.id, 'aria-label': `Start the lesson: ${l.title}`, onclick: () => this.start(l.id) }, 'Start')))),
    ];
  }

  private start(id: string): void {
    if (!this.confirmStart()) return;
    if (this.editor.startLesson(id)) this.onStart();
  }

  private active(): Child[] {
    const ed = this.editor;
    const lesson = ed.lesson!;
    const p = ed.lessonProgress!;
    const firstOpen = p.steps.findIndex((s) => !s.done);
    const out: Child[] = [
      h('div', { class: 'btn-row' }, h('h2', { 'data-testid': 'lesson-title' }, lesson.title), h('button', { class: 'btn', type: 'button', 'data-testid': 'leave-lesson', onclick: () => ed.leaveLesson() }, 'Leave lesson')),
      h('p', { class: 'hint' }, lesson.assumptions),
      h('ol', { class: 'steps', 'aria-label': 'Steps' },
        ...lesson.steps.map((s, i) => {
          const done = p.steps[i]!.done;
          const current = i === firstOpen;
          return h('li', { class: `step ${done ? 'done' : current ? 'current' : 'todo'}`, 'data-testid': 'lesson-step', 'data-step': s.id, 'data-done': String(done), ...(current ? { 'aria-current': 'step' } : {}) },
            h('div', { class: 'step-state' }, icon(done ? 'check' : 'warn'), done ? ' Done' : current ? ' Next' : ' Not yet'),
            h('div', {}, s.prompt),
            current ? h('details', {}, h('summary', {}, 'Hint'), h('p', {}, s.hint)) : null);
        })),
    ];
    const blank = ed.doc.top === '' && ed.doc.events.length === 0 && ed.doc.gates.length === 0; // a lesson that has just started is empty, not broken
    if (p.malformed && blank) out.push(h('p', { class: 'hint', role: 'status', 'data-testid': 'lesson-blank' }, 'The model is empty. Start with the first step above.'));
    else if (p.malformed) out.push(h('div', { class: 'caveat', role: 'status' }, 'Part of the model is not in a form the lesson can read, so no step is credited yet.'));
    if (p.mistakes.length) {
      out.push(h('div', { class: 'caveat', role: 'status', 'data-testid': 'lesson-mistakes' }, h('strong', {}, 'Check this. '), h('ul', {}, ...p.mistakes.map((m) => h('li', { 'data-mistake': m.id }, m.message)))));
    }
    const allSteps = p.steps.every((s) => s.done);
    if (ed.result?.kind === 'ran' && ed.stale) out.push(h('p', { class: 'hint', role: 'status' }, 'The result on the Results tab is out of date. Run again to check this version of the model.'));
    if (p.complete) {
      const label = lesson.outcomes.find((o) => o.id === p.outcome)?.label ?? '';
      out.push(h('div', { class: 'success', role: 'status', 'data-testid': 'lesson-complete' }, h('strong', {}, 'Lesson complete. '), `Your result matches the expected one: ${label}.`));
    } else if (allSteps && p.mistakes.length === 0 && !ed.lessonResult) {
      out.push(h('p', { class: 'hint', role: 'status', 'data-testid': 'lesson-run-prompt' }, 'The steps are done. Press Run to check your result against the expected value.'));
    } else if (allSteps && p.mistakes.length === 0 && ed.lessonResult && !p.outcome) {
      out.push(h('p', { class: 'hint', role: 'status', 'data-testid': 'lesson-mismatch' }, 'Your result does not match any expected result for this lesson. Compare your gates and probabilities with the steps above, and check that each event is named as the steps say: the lesson finds events by their names.'));
    }
    out.push(h('h2', {}, 'Hand calculation'));
    if (ed.calcShown) out.push(h('ul', { 'data-testid': 'lesson-calc' }, ...lesson.hand_calculation.map((t) => h('li', {}, t))));
    else {
      out.push(h('p', { class: 'hint' }, 'Try the lesson and run the model first. Then the worked answer is available.'));
      out.push(h('button', { class: 'btn', type: 'button', 'data-testid': 'show-calc', disabled: !ed.hasTried, onclick: () => ed.showCalculation() }, 'Show the hand calculation'));
    }
    return out;
  }
}
