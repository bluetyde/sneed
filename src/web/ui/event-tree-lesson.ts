// The Lessons section of the event-tree view: pick a lesson, then follow its steps beside the tables. Progress comes from the lesson checker and
// the analysis; nothing here looks at anything drawn. State is conveyed in words, never by colour alone. The instructor's discussion questions
// and answers are never shown here.
import type { EventTreeEditor } from '../model/event-tree-editor.js';
import { h, rerender, type Child } from './dom.js';
import { icon } from './icons.js';
import { fmt } from './results.js';

export class EventTreeLessonPanel {
  readonly el = h('details', { class: 'et-lessons', 'data-testid': 'et-lessons' });
  private signature = '';
  private open = false;
  /** Asked before a lesson replaces the tree on the screen; set by the view. */
  confirmStart: () => boolean = () => true;

  constructor(private readonly ed: EventTreeEditor) {
    this.el.addEventListener('toggle', () => {
      this.open = (this.el as HTMLDetailsElement).open;
    });
  }

  render(): void {
    const ed = this.ed;
    const sig = JSON.stringify([ed.lessons.map((l) => l.id), ed.lessonsError, ed.lesson?.id, ed.lessonProgress, ed.calcShown, ed.hasTried, ed.reveal, ed.currentRecord === null, ed.stale, ed.running, ed.predictionAtResult]);
    if (sig === this.signature) return;
    this.signature = sig;
    if (ed.lesson) this.open = true;
    (this.el as HTMLDetailsElement).open = this.open;
    rerender(this.el, () => [h('summary', {}, ed.lesson ? `Lesson: ${ed.lesson.title}` : `Lessons (${ed.lessons.length})`), ...(ed.lesson ? this.active() : this.list())]);
  }

  private list(): Child[] {
    const ed = this.ed;
    if (ed.lessonsError) return [h('div', { class: 'notice error', role: 'alert', 'data-testid': 'et-lessons-error' }, ed.lessonsError)];
    if (ed.lessons.length === 0) return [h('p', { class: 'empty-state', 'data-testid': 'et-no-lessons' }, 'No event-tree lessons are available.')];
    return [
      h('p', { class: 'hint' }, 'Short guided exercises on event trees. Every number is made up for teaching and describes no real plant. Starting a lesson replaces the event tree on the screen, and saves the lesson\'s own fault-tree model under its own name. A model of yours with that name is never replaced: the lesson then uses a numbered name.'),
      h('ol', { class: 'lessons', 'aria-label': 'Event-tree lessons' },
        ...ed.lessons.map((l) =>
          h('li', {},
            h('h3', {}, l.title),
            h('ul', { class: 'goals' }, ...l.goals.map((g) => h('li', {}, g))),
            h('button', { class: 'btn', type: 'button', 'data-testid': 'et-start-lesson', 'data-lesson': l.id, 'aria-label': `Start the lesson: ${l.title}`, onclick: () => void this.start(l.id) }, 'Start')))),
    ];
  }

  private async start(id: string): Promise<void> {
    if (!this.confirmStart()) return;
    await this.ed.startLesson(id);
  }

  private active(): Child[] {
    const ed = this.ed;
    const lesson = ed.lesson!;
    const p = ed.lessonProgress!;
    const firstOpen = p.steps.findIndex((s) => !s.done);
    const out: Child[] = [
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-testid': 'et-leave-lesson', onclick: () => ed.leaveLesson() }, 'Leave lesson')),
      h('p', { class: 'hint', 'data-testid': 'et-lesson-assumptions' }, lesson.assumptions),
      h('ol', { class: 'steps', 'aria-label': 'Steps' },
        ...lesson.steps.map((s, i) => {
          const done = p.steps[i]!.done;
          const current = i === firstOpen;
          return h('li', { class: `step ${done ? 'done' : current ? 'current' : 'todo'}`, 'data-testid': 'et-lesson-step', 'data-step': s.id, 'data-done': String(done), ...(current ? { 'aria-current': 'step' } : {}) },
            h('div', { class: 'step-state' }, icon(done ? 'check' : 'warn'), done ? ' Done' : current ? ' Next' : ' Not yet'),
            h('div', {}, s.prompt),
            current ? h('details', {}, h('summary', {}, 'Hint'), h('p', {}, s.hint)) : null);
        })),
    ];
    if (lesson.prediction) {
      out.push(h('div', { class: 'field' },
        h('label', { for: 'et-prediction' }, 'Your prediction (per year)'),
        h('span', { class: 'hint', id: 'et-prediction-hint' }, lesson.prediction.prompt),
        h('input', { type: 'text', id: 'et-prediction', inputmode: 'decimal', 'data-field': 'et-prediction', 'aria-describedby': 'et-prediction-hint', value: ed.predictionText, onchange: (e) => ed.setPrediction((e.target as HTMLInputElement).value) })));
    }
    if (p.malformed) out.push(h('div', { class: 'caveat', role: 'status' }, 'Part of the event tree is not in a form the lesson can read, so no step is credited yet.'));
    if (p.modelMismatch) out.push(h('div', { class: 'caveat', role: 'status', 'data-testid': 'et-lesson-model-mismatch' }, h('strong', {}, 'Check this. '), 'The analysis on show was made with a different fault-tree model from the lesson\'s, so it cannot complete the lesson. Choose the lesson\'s model in "Headings are events of this saved model" and press Analyse again.'));
    if (p.mistakes.length) out.push(h('div', { class: 'caveat', role: 'status', 'data-testid': 'et-lesson-mistakes' }, h('strong', {}, 'Check this. '), h('ul', {}, ...p.mistakes.map((m) => h('li', { 'data-mistake': m.id }, m.message)))));
    const allSteps = p.steps.every((s) => s.done);
    if (ed.result?.kind === 'ran' && ed.stale) out.push(h('p', { class: 'hint', role: 'status' }, 'The analysis on show is out of date. Press Analyse again to check this version of the event tree.'));
    if (p.complete) {
      const label = lesson.outcomes.find((o) => o.id === p.outcome)?.label ?? '';
      out.push(h('div', { class: 'success', role: 'status', 'data-testid': 'et-lesson-complete' }, h('strong', {}, 'Lesson complete. '), `Your analysis matches the expected one: ${label}.`));
    } else if (allSteps && p.mistakes.length === 0 && !ed.currentRecord && !ed.running) {
      out.push(h('p', { class: 'hint', role: 'status', 'data-testid': 'et-lesson-run-prompt' }, 'The steps are done. Press Analyse to check your result against the expected one.'));
    } else if (allSteps && p.mistakes.length === 0 && ed.currentRecord && !p.outcome) {
      out.push(h('p', { class: 'hint', role: 'status', 'data-testid': 'et-lesson-mismatch' }, 'Your analysis does not match the expected one for this lesson. Compare the headings, their order and the frequency with the steps above.'));
    }
    const r = ed.reveal;
    if (lesson.prediction && ed.currentRecord && r) {
      out.push(h('div', { class: 'caveat', role: 'status', 'data-testid': 'et-lesson-reveal' },
        h('strong', {}, 'Your prediction and the result. '),
        `You predicted ${fmt(r.predicted)} per year. The analysis gives ${fmt(r.exact)} per year. `,
        `Multiplying the two failure probabilities (${r.failureProbabilities.map(fmt).join(' and ')}) and the initiating-event frequency would give ${fmt(r.product)} per year, which is ${fmt(Math.round(r.productBelow * 1000) / 10)} percent below the exact value. `,
        'That product is right only when the headings fail independently.'));
    } else if (lesson.prediction && ed.currentRecord) {
      out.push(h('p', { class: 'hint', role: 'status', 'data-testid': 'et-lesson-no-prediction' }, 'There was no prediction typed when you pressed Analyse, so there is nothing to compare. Type one, then press Analyse again.'));
    }
    out.push(h('h3', {}, 'Hand calculation'));
    if (ed.calcShown) out.push(h('ul', { 'data-testid': 'et-lesson-calc' }, ...lesson.hand_calculation.map((t) => h('li', {}, t))));
    else {
      out.push(h('p', { class: 'hint' }, 'Try the lesson and press Analyse first. Then the worked answer is available.'));
      out.push(h('button', { class: 'btn', type: 'button', 'data-testid': 'et-show-calc', disabled: !ed.hasTried, onclick: () => ed.showCalculation() }, 'Show the hand calculation'));
    }
    return out;
  }
}
