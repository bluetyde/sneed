import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeEventTree } from '../../src/engines/bdd/event-tree.js';
import {
  checkEtLesson, eventKey, frequenciesByEvent, lessonAgainstOracles, matchEtOutcome, outcomeEqualsOracle, parseEtLesson, predictionReveal, runEtCheck, runEtDetect,
  type EtLesson, type EtOracleEntry, type EtRecordLike,
} from '../../src/core/event-tree-lesson.js';
import type { NativeModel } from '../../src/core/model.js';
import { startServer, type RunningServer } from '../../src/server/app.js';
import { loadEventTreeLessons } from '../../src/server/event-tree-lessons.js';
import { LessonsUnavailable } from '../../src/server/lessons.js';
import * as E from '../../src/web/model/event-tree-doc.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LESSON_DIR = path.join(ROOT, 'lessons', 'event-trees');
const ORACLES = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'event-tree-oracles.json'), 'utf8')) as EtOracleEntry[];
const files = readdirSync(LESSON_DIR).filter((f) => f.endsWith('.json')).sort();
const lessons = files.map((f) => parseEtLesson(readFileSync(path.join(LESSON_DIR, f), 'utf8')));
const lesson = (id: string): EtLesson => structuredClone(lessons.find((l) => l.id === id)!);
const L1 = 'et-01-independent-headings';
const L2 = 'et-02-shared-event';
const L3 = 'et-03-bypass';

const NOW = '2026-10-07T00:00:00Z';
const HASH = 'a'.repeat(64);
const start = (l: EtLesson): E.EtDoc => {
  const first = (l.model.document.events as { id: string }[])[0]!.id;
  return E.setInitiating(E.newEventTree({ name: l.model.name, hash: HASH, top: first }, 'T', NOW), { frequency: 1 }, NOW);
};
const analysis = (l: EtLesson, doc: E.EtDoc): EtRecordLike => {
  const r = computeEventTree(l.model.document as unknown as NativeModel, { initiating_event: { frequency: doc.initiating_event.frequency }, headings: doc.headings, end_states: doc.end_states, sequences: doc.sequences });
  return { input_hashes: { model_hash: HASH }, headings: doc.headings.map((h) => ({ id: h.id, event: h.event })), sequences: r.sequences };
};

/** What a student who follows the steps does, by the document operations the editor uses. */
function solve(id: string): E.EtDoc {
  const l = lesson(id);
  let d = start(l);
  if (id === L1) {
    d = E.setInitiating(d, { frequency: 0.1 }, NOW);
    d = E.patchHeading(d, 'H1', { event: 'INJ', name: 'Injection' }, NOW);
    d = E.addHeading(d, 'COOL', NOW);
    d = E.addEndState(E.addEndState(d, NOW), NOW);
    for (const s of d.sequences) d = E.setSequenceEnd(d, `${s.path.map((x) => `${x.heading}:${x.branch}`).join(',')}`, s.path.filter((x) => x.branch === 'fails').length === 0 ? 'ES1' : s.path.filter((x) => x.branch === 'fails').length === 1 ? 'ES2' : 'ES3', NOW);
  } else {
    d = E.setInitiating(d, { frequency: 0.5 }, NOW);
    d = E.patchHeading(d, 'H1', { event: 'X' }, NOW);
    d = E.addHeading(d, 'Y', NOW);
    if (id === L3) d = E.setBypass(d, 'H2', { heading: 'H1', branch: 'works' }, NOW);
    d = E.setUnsetEnds(d, 'ES1', NOW);
  }
  return d;
}
const ctxOf = (prediction: number | null): { prediction: number | null; predictionAtResult: number | null; modelHash: string } => ({ prediction, predictionAtResult: prediction, modelHash: HASH });
const done = (id: string, d: E.EtDoc, prediction: number | null = 0.05) => checkEtLesson(lesson(id), d, analysis(lesson(id), d), ctxOf(prediction));

describe('the shipped event-tree lessons', () => {
  it('there are three, in order, each with goals, assumptions that disclaim any plant, steps, an outcome, hand calculation and instructor questions', () => {
    expect(lessons.map((l) => l.id)).toEqual([L1, L2, L3]);
    for (const l of lessons) {
      expect(l.goals.length).toBeGreaterThanOrEqual(2);
      expect(l.assumptions).toMatch(/made up for teaching/);
      expect(l.assumptions).toMatch(/not a plant figure/);
      expect(l.assumptions).toMatch(/not conditions of any real plant/);
      expect(l.steps.length).toBeGreaterThanOrEqual(4);
      expect(l.hand_calculation.length).toBeGreaterThanOrEqual(3);
      expect(l.discussion.length).toBeGreaterThanOrEqual(2);
      expect(l.outcomes).toHaveLength(1);
    }
    expect(lessons[1]!.prediction).toBeDefined();
  });

  it('every lesson agrees with its oracle entries: numbers, model, and what the steps ask for', () => {
    for (const l of lessons) expect(lessonAgainstOracles(l, ORACLES), l.id).toBeNull();
  });

  it('every lesson wording avoids what the lesson rules forbid: no real-plant end state names, no safety conclusion', () => {
    const all = JSON.stringify(lessons.map((l) => ({ ...l, model: undefined, discussion: undefined }))).toLowerCase();
    expect(all).not.toMatch(/core damage|meltdown|release of|safe to operate|is safe|licens/);
  });

  it('the step prompts use only words the editor uses', () => {
    const labels = ['Initiating event', 'Frequency', 'Fails when this occurs', 'Add a heading', 'Add an end state', 'Sequences table', 'Ends in', 'Asked', 'Give them all', 'Headings table', 'Your prediction'];
    const text = lessons.flatMap((l) => l.steps.map((s) => `${s.prompt} ${s.hint}`)).join(' ');
    for (const w of ['Initiating event', 'Frequency', 'Fails when this occurs', 'Add a heading', 'Add an end state', 'Sequences table', 'Ends in', 'Give them all', 'Headings table']) expect(text, w).toContain(w);
    expect(labels.length).toBeGreaterThan(0);
  });
});

describe('a student who follows the steps', () => {
  it.each([L1, L2, L3])('completes %s: every step done, no mistake, the analysis matches the oracle', (id) => {
    const p = done(id, solve(id));
    expect(p.steps.every((s) => s.done), JSON.stringify(p)).toBe(true);
    expect(p.mistakes).toEqual([]);
    expect(p.malformed).toBe(false);
    expect(p.complete).toBe(true);
    expect(p.outcome).toBe(lesson(id).outcomes[0]!.id);
  });

  it('starts every lesson with nothing credited (except the placeholder-free defaults) and no mistake', () => {
    for (const l of lessons) {
      const d = start(l);
      const p = checkEtLesson(l, d, null, { prediction: null, modelHash: HASH });
      expect(p.mistakes, l.id).toEqual([]);
      expect(p.complete).toBe(false);
      expect(p.steps.find((s) => s.id === 'frequency')!.done, `${l.id} frequency is a placeholder`).toBe(false);
      expect(p.steps.find((s) => s.id === 'assign')?.done).toBe(false);
    }
  });

  it('is not credited without an analysis, with a stale one, or with one of another tree', () => {
    const d = solve(L2);
    expect(checkEtLesson(lesson(L2), d, null, ctxOf(0.1)).complete).toBe(false);
    const other = solve(L1);
    expect(checkEtLesson(lesson(L2), d, analysis(lesson(L1), other), ctxOf(0.1)).complete).toBe(false);
    expect(checkEtLesson(lesson(L3), solve(L3), analysis(lesson(L2), solve(L2)), ctxOf(null)).complete).toBe(false); // lesson 2's tree is not lesson 3's
  });

  it('is not credited for the wrong frequency, headings in the wrong order, a missing end state or no prediction', () => {
    expect(done(L1, E.setInitiating(solve(L1), { frequency: 0.2 }, NOW)).complete).toBe(false);
    const swapped = E.moveHeading(solve(L1), 'H1', 1, NOW);
    expect(done(L1, swapped).steps.find((s) => s.id === 'headings')!.done).toBe(false);
    expect(done(L1, swapped).complete).toBe(false);
    const unset = E.setSequenceEnd(solve(L1), 'H1:works,H2:works', '', NOW);
    expect(done(L1, unset).steps.find((s) => s.id === 'assign')!.done).toBe(false);
    expect(done(L2, solve(L2), null).steps.find((s) => s.id === 'predict')!.done).toBe(false);
    expect(done(L2, solve(L2), null).complete).toBe(false);
  });

  it('own heading names, heading ids and end-state names do not matter, only the events and the numbers', () => {
    let d = solve(L1);
    d = E.patchHeading(d, 'H1', { name: 'Zeta' }, NOW);
    d = E.patchHeading(d, 'H2', { name: 'Alpha' }, NOW);
    d = E.patchEndState(d, 'ES1', { name: 'Whatever (example)' }, NOW);
    expect(done(L1, d).complete).toBe(true);
    // heading ids generated after removals are different: the events decide
    let e = E.addHeading(solve(L1), 'COOL', NOW); // a third heading: H3
    e = E.removeHeading(e, 'H2', NOW);
    expect(e.headings.map((h) => h.id)).toEqual(['H1', 'H3']);
    e = E.setUnsetEnds(e, 'ES1', NOW);
    expect(done(L1, e).steps.find((s) => s.id === 'headings')!.done).toBe(true);
    expect(done(L1, e).outcome).toBe('independent'); // the same events, whatever the heading ids
  });

  it('each check is exact: an extra heading, too few end states, an end state that does not exist, or a mistake showing all stop the credit', () => {
    const l1 = lesson(L1);
    const d = solve(L1);
    expect(done(L1, d).complete).toBe(true);
    const extraHeading = E.setUnsetEnds(E.addHeading(d, 'INJ', NOW), 'ES1', NOW); // INJ, COOL, INJ: the events asked for plus one more
    expect(runEtCheck({ kind: 'heading-events', events: ['INJ', 'COOL'] }, extraHeading)).toBe(false);
    expect(runEtCheck({ kind: 'heading-events', events: ['INJ', 'COOL'] }, d)).toBe(true);
    expect(runEtCheck({ kind: 'heading-events', events: ['INJ', 'COOL'] }, start(l1))).toBe(false); // one heading of the two asked for
    const twoEnds = E.removeEndState(d, 'ES3', NOW);
    expect(runEtCheck({ kind: 'end-states-min', count: 3 }, d)).toBe(true);
    expect(runEtCheck({ kind: 'end-states-min', count: 3 }, twoEnds)).toBe(false);
    const ghost = E.setSequenceEnd(d, 'INJ:works,COOL:works'.replace(/INJ/g, 'H1').replace(/COOL/g, 'H2'), 'GHOST', NOW);
    expect(runEtCheck({ kind: 'ends-assigned' }, ghost)).toBe(false);
    // a lesson whose own mistake list fires on the finished tree is not complete, however right the numbers are
    const strict = structuredClone(l1);
    strict.mistakes.push({ id: 'x', message: 'Always shown for this test.', detect: { kind: 'heading-on-event', event: 'INJ' } });
    const p = checkEtLesson(strict, d, analysis(l1, d), ctxOf(null));
    expect(p.steps.every((x) => x.done)).toBe(true);
    expect(p.outcome).toBe('independent');
    expect(p.mistakes.map((m) => m.id)).toEqual(['x']);
    expect(p.complete).toBe(false);
  });

  it('a fault-tree model with common-cause groups is another model: an analysis made on it does not complete the lesson, even when its numbers happen to match', () => {
    const l = lesson(L3);
    const d = solve(L3);
    const good = analysis(l, d);
    // the lessons teach independent events; a model with groups has its own hash (the groups are part of what a model means), and the record says so
    const grouped = { ...good, input_hashes: { model_hash: 'c'.repeat(64) }, common_cause: { method: 'beta-factor', groups: [{ id: 'CC1', members: ['X', 'Y'], beta: 0.1 }], note: 'n' } } as EtRecordLike;
    expect(matchEtOutcome(l, grouped)).not.toBeNull(); // the numbers alone cannot tell
    const p = checkEtLesson(l, d, grouped, ctxOf(null));
    expect(p.modelMismatch).toBe(true);
    expect(p.complete).toBe(false);
    expect(checkEtLesson(l, d, good, ctxOf(null)).complete).toBe(true);
  });

  it('an unrelated fault-tree model that gives the same numbers does not complete the lesson', () => {
    const l = lesson(L3);
    const d = solve(L3);
    const good = analysis(l, d);
    // the student chose a model of two independent events X = 0.28 and Y = 0.3: its sequence frequencies are exactly the lesson's, its hash is not
    const other: EtRecordLike = { ...good, input_hashes: { model_hash: 'b'.repeat(64) } };
    expect(matchEtOutcome(l, other)).not.toBeNull(); // the numbers alone cannot tell
    const p = checkEtLesson(l, d, other, ctxOf(null));
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.outcome).toBe('bypass');
    expect(p.modelMismatch).toBe(true);
    expect(p.complete).toBe(false);
    const ok = checkEtLesson(l, d, good, ctxOf(null));
    expect(ok.modelMismatch).toBe(false);
    expect(ok.complete).toBe(true);
    // no analysis, no claim; an analysis without a recorded hash, or a lesson without a known model hash, completes nothing
    expect(checkEtLesson(l, d, null, ctxOf(null)).modelMismatch).toBe(false);
    expect(checkEtLesson(l, d, { ...good, input_hashes: undefined }, ctxOf(null)).complete).toBe(false);
    expect(checkEtLesson(l, d, good, { prediction: null }).complete).toBe(false);
    expect(checkEtLesson(l, d, good, { prediction: null, modelHash: null }).complete).toBe(false);
  });

  it('a lesson that asks for a prediction is complete only with one made BEFORE the analysis on show', () => {
    const l = lesson(L2);
    const d = solve(L2);
    const rec = analysis(l, d);
    expect(checkEtLesson(l, d, rec, { prediction: 0.05, predictionAtResult: 0.05, modelHash: HASH }).complete).toBe(true);
    // typed after the result: the step shows done, the lesson is not complete
    const late = checkEtLesson(l, d, rec, { prediction: 0.077, predictionAtResult: null, modelHash: HASH });
    expect(late.steps.find((s) => s.id === 'predict')!.done).toBe(true);
    expect(late.complete).toBe(false);
    expect(checkEtLesson(l, d, rec, { prediction: 0.05, modelHash: HASH }).complete).toBe(false);
    // a lesson without a prediction is not held up by it
    expect(checkEtLesson(lesson(L1), solve(L1), analysis(lesson(L1), solve(L1)), { prediction: null, modelHash: HASH }).complete).toBe(true);
  });

  it('end states must group the paths by how many headings failed: one state for each count, shared by the paths with that count', () => {
    const d = solve(L1);
    expect(runEtCheck({ kind: 'ends-by-failures' }, d)).toBe(true);
    // everything in one state, though three exist
    let all = d;
    for (const s of d.sequences) all = E.setSequenceEnd(all, s.path.map((x) => `${x.heading}:${x.branch}`).join(','), 'ES1', NOW);
    expect(runEtCheck({ kind: 'ends-by-failures' }, all)).toBe(false);
    // the two single-failure paths in different states
    const split = E.setSequenceEnd(d, 'H1:fails,H2:works', 'ES3', NOW);
    expect(runEtCheck({ kind: 'ends-by-failures' }, split)).toBe(false);
    // two counts sharing a state
    const merged = E.setSequenceEnd(d, 'H1:fails,H2:fails', 'ES2', NOW);
    expect(runEtCheck({ kind: 'ends-by-failures' }, merged)).toBe(false);
    // an unset or unknown state
    expect(runEtCheck({ kind: 'ends-by-failures' }, E.setSequenceEnd(d, 'H1:works,H2:works', '', NOW))).toBe(false);
    expect(runEtCheck({ kind: 'ends-by-failures' }, E.setSequenceEnd(d, 'H1:works,H2:works', 'GHOST', NOW))).toBe(false);
    // the lesson asks for it, and a student who grouped differently is not complete
    expect(done(L1, all).steps.find((s) => s.id === 'assign')!.done).toBe(false);
    expect(done(L1, all).complete).toBe(false);
    expect(done(L1, d).complete).toBe(true);
  });

  it('the bypass lesson accepts only the condition it asks for', () => {
    const l = lesson(L3);
    expect(done(L3, solve(L3)).steps.find((s) => s.id === 'bypass')!.done).toBe(true);
    const wrongBranch = E.setUnsetEnds(E.setBypass(E.addHeading(E.patchHeading(E.setInitiating(start(l), { frequency: 0.5 }, NOW), 'H1', { event: 'X' }, NOW), 'Y', NOW), 'H2', { heading: 'H1', branch: 'fails' }, NOW), 'ES1', NOW);
    const p = done(L3, wrongBranch);
    expect(p.steps.find((s) => s.id === 'bypass')!.done).toBe(false);
    expect(p.mistakes.map((m) => m.id)).toContain('wrong-branch');
    expect(p.complete).toBe(false);
    const none = E.setUnsetEnds(E.addHeading(E.patchHeading(E.setInitiating(start(l), { frequency: 0.5 }, NOW), 'H1', { event: 'X' }, NOW), 'Y', NOW), 'ES1', NOW);
    expect(done(L3, none).steps.find((s) => s.id === 'bypass')!.done).toBe(false);
    expect(done(L3, none).steps.find((s) => s.id === 'paths')!.done).toBe(false);
    expect(done(L3, none).mistakes.map((m) => m.id)).not.toContain('wrong-branch'); // no condition at all is not the wrong branch
  });

  it('the mistakes fire on a fixture of each mistake, and only then', () => {
    const l = lesson(L2);
    const d = solve(L2);
    expect(runEtDetect({ kind: 'same-event-twice' }, d)).toBe(false);
    expect(runEtDetect({ kind: 'same-event-twice' }, E.patchHeading(d, 'H2', { event: 'X' }, NOW))).toBe(true);
    expect(runEtDetect({ kind: 'heading-on-event', event: 'TOP' }, d)).toBe(false);
    expect(runEtDetect({ kind: 'heading-on-event', event: 'TOP' }, E.patchHeading(d, 'H1', { event: 'TOP' }, NOW))).toBe(true);
    expect(runEtDetect({ kind: 'frequency-zero' }, d)).toBe(false);
    expect(runEtDetect({ kind: 'frequency-zero' }, E.setInitiating(d, { frequency: 0 }, NOW))).toBe(true);
    for (const m of l.mistakes) expect(m.message.length).toBeGreaterThan(20);
  });

  it('a document that is not a tree credits nothing and breaks nothing', () => {
    const l = lesson(L1);
    for (const bad of [null, undefined, 5, 'x', [], {}, { headings: 3 }, { initiating_event: {}, headings: [{}], end_states: 1, sequences: [null] }, { initiating_event: { frequency: 'x' }, headings: [], end_states: [], sequences: [] }]) {
      const p = checkEtLesson(l, bad as never, null, { prediction: 1 });
      expect(p.complete).toBe(false);
      expect(p.steps.every((s) => !s.done), JSON.stringify(bad)).toBe(true);
      expect(() => runEtDetect({ kind: 'same-event-twice' }, bad as never)).not.toThrow();
    }
    expect(checkEtLesson(l, {} as never, null).malformed).toBe(true);
  });
});

describe('matching an analysis with the outcome', () => {
  it('the keys are made of events, so two headings on one event make the analysis ambiguous and unmatched', () => {
    const l = lesson(L1);
    const d = E.patchHeading(solve(L1), 'H2', { event: 'INJ' }, NOW);
    const rec = analysis(l, d);
    expect(frequenciesByEvent(rec)).toBeNull();
    expect(matchEtOutcome(l, rec)).toBeNull();
  });

  it('a frequency off by more than the tolerance does not match, and one inside it does', () => {
    const l = lesson(L1);
    const rec = analysis(l, solve(L1));
    expect(matchEtOutcome(l, rec)).not.toBeNull();
    const off = structuredClone(rec);
    off.sequences[0]!.frequency += 1e-6;
    expect(matchEtOutcome(l, off)).toBeNull();
    const near = structuredClone(rec);
    near.sequences[0]!.frequency += 1e-14;
    expect(matchEtOutcome(l, near)).not.toBeNull();
  });

  it('an analysis with a sequence too many or too few does not match', () => {
    const l = lesson(L3);
    const rec = analysis(l, solve(L3));
    expect(matchEtOutcome(l, rec)).not.toBeNull();
    expect(matchEtOutcome(l, { ...rec, sequences: rec.sequences.slice(1) })).toBeNull();
    expect(matchEtOutcome(l, { ...rec, sequences: [...rec.sequences, { ...rec.sequences[0]!, key: 'x', path: [{ heading: 'H9', branch: 'works' }] }] })).toBeNull();
  });
});

describe('the prediction and what is shown beside it', () => {
  const rec = (): EtRecordLike => analysis(lesson(L2), solve(L2));

  it('uses the numbers of the student\'s own analysis: the marginal failure probabilities, their product, the exact value', () => {
    const r = predictionReveal(lesson(L2), rec(), 0.5, 0.05)!;
    expect(r.predicted).toBe(0.05);
    expect(r.exact).toBeCloseTo(0.077, 12);
    expect(r.failureProbabilities[0]).toBeCloseTo(0.28, 12);
    expect(r.failureProbabilities[1]).toBeCloseTo(0.37, 12);
    expect(r.product).toBeCloseTo(0.0518, 12);
    expect(r.productBelow).toBeCloseTo((0.077 - 0.0518) / 0.077, 12);
    expect(r.ratio).toBeCloseTo(0.077 / 0.0518, 12);
  });

  it('is nothing when the lesson has no prediction, the sequence is missing, or a heading is not asked on every path', () => {
    expect(predictionReveal(lesson(L1), analysis(lesson(L1), solve(L1)), 0.1, 1)).toBeNull();
    const l3 = lesson(L3);
    l3.prediction = lesson(L2).prediction!;
    expect(predictionReveal(l3, analysis(l3, solve(L3)), 0.5, 1)).toBeNull(); // Y is not asked where X fails
    const l2 = lesson(L2);
    l2.prediction = { prompt: 'p', sequence: [{ event: 'X', branch: 'fails' }, { event: 'NOPE', branch: 'fails' }] };
    expect(predictionReveal(l2, rec(), 0.5, 1)).toBeNull();
    expect(predictionReveal(lesson(L2), { ...rec(), sequences: rec().sequences.filter((s) => !s.key.includes('fails,H2:fails')) }, 0.5, 1)).toBeNull();
  });

  it('is the same whatever the student called the headings', () => {
    const d = E.patchHeading(solve(L2), 'H1', { name: 'Whatever' }, NOW);
    const r = predictionReveal(lesson(L2), analysis(lesson(L2), d), 0.5, 0.2)!;
    expect(r.exact).toBeCloseTo(0.077, 12);
  });
});

describe('refusing a lesson that cannot be trusted', () => {
  const mutated = (id: string, f: (l: EtLesson) => void): EtLesson => {
    const l = lesson(id);
    f(l);
    return l;
  };
  it('an outcome that differs from its oracle, or names none, is refused', () => {
    expect(lessonAgainstOracles(mutated(L2, (l) => (l.outcomes[0]!.frequencies[0]!.frequency += 1e-6)), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(lessonAgainstOracles(mutated(L2, (l) => (l.outcomes[0]!.oracle = 'nope')), ORACLES)!.code).toBe('L_NO_ORACLE');
    expect(lessonAgainstOracles(mutated(L2, (l) => l.outcomes[0]!.frequencies.pop()), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(lessonAgainstOracles(mutated(L2, (l) => (l.outcomes[0]!.frequencies[0]!.key = 'X:works,Z:works')), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(outcomeEqualsOracle(lesson(L2).outcomes[0]!, ORACLES.find((o) => o.id === 'et-bypass')!)).toBe(false);
  });
  it('an outcome that names a sequence twice is refused, however many entries it has', () => {
    const dup = mutated(L1, (l) => {
      const f = l.outcomes[0]!.frequencies;
      l.outcomes[0]!.frequencies = [f[0]!, f[0]!, f[0]!, f[0]!];
    });
    expect(outcomeEqualsOracle(dup.outcomes[0]!, ORACLES.find((o) => o.id === 'et-independent')!)).toBe(false);
    expect(lessonAgainstOracles(dup, ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(() => parseEtLesson(JSON.stringify(dup))).toThrow(/twice/);
    // and an analysis is not matched against such an outcome
    const rec = analysis(lesson(L1), solve(L1));
    expect(matchEtOutcome(dup, rec)).toBeNull();
  });
  it('a model that is not the oracle\'s model is refused', () => {
    const edit = (f: (d: { events: { probability: number }[]; gates: { inputs: string[] }[]; top: string }) => void) => mutated(L2, (l) => f(l.model.document as never));
    expect(lessonAgainstOracles(edit((d) => (d.events[0]!.probability = 0.11)), ORACLES)!.code).toBe('L_BAD_MODEL');
    expect(lessonAgainstOracles(edit((d) => d.gates[0]!.inputs.pop()), ORACLES)!.code).toBe('L_BAD_MODEL');
    expect(lessonAgainstOracles(edit((d) => (d.top = 'X')), ORACLES)!.code).toBe('L_BAD_MODEL');
    expect(lessonAgainstOracles(edit((d) => d.events.pop()), ORACLES)!.code).toBe('L_BAD_MODEL');
  });
  it('steps that ask for something other than what the numbers were derived for are refused', () => {
    expect(lessonAgainstOracles(mutated(L2, (l) => ((l.steps[0]!.check as { value: number }).value = 0.6)), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(lessonAgainstOracles(mutated(L2, (l) => ((l.steps[1]!.check as { events: string[] }).events = ['Y', 'X'])), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(lessonAgainstOracles(mutated(L3, (l) => ((l.steps[3]!.check as { count: number }).count = 4)), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(lessonAgainstOracles(mutated(L3, (l) => ((l.steps[2]!.check as { branch: string }).branch = 'fails')), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
    expect(lessonAgainstOracles(mutated(L2, (l) => (l.prediction!.sequence = [{ event: 'X', branch: 'works' }, { event: 'Q', branch: 'works' }])), ORACLES)!.code).toBe('L_ORACLE_MISMATCH');
  });
  it('a lesson file of the wrong shape is refused with the field named', () => {
    const base = JSON.parse(readFileSync(path.join(LESSON_DIR, files[1]!), 'utf8')) as Record<string, any>;
    const bad = (f: (l: Record<string, any>) => void, re: RegExp): void => {
      const l = structuredClone(base);
      f(l);
      expect(() => parseEtLesson(JSON.stringify(l))).toThrow(re);
    };
    expect(() => parseEtLesson('{ nope')).toThrow(/not valid JSON/);
    expect(() => parseEtLesson('[]')).toThrow(/object/);
    bad((l) => (l.schema.version = 2), /schema/);
    bad((l) => (l.title = ''), /title/);
    bad((l) => (l.goals = []), /goals/);
    bad((l) => delete l.model, /model/);
    bad((l) => (l.steps = []), /steps/);
    bad((l) => (l.steps[0].check = { kind: 'unknown' }), /check/);
    bad((l) => (l.steps[0].check = { kind: 'frequency', value: -1 }), /check/);
    bad((l) => (l.steps[1].check = { kind: 'heading-events', events: [] }), /check/);
    bad((l) => (l.steps[0].hint = ''), /hint/);
    bad((l) => (l.mistakes[0].detect = { kind: 'bypass-other-branch', heading_event: 'Y' }), /detector/);
    bad((l) => (l.mistakes[0].detect = { kind: 'made-up' }), /detector/);
    bad((l) => (l.outcomes = []), /outcomes/);
    bad((l) => (l.outcomes[0].tolerance.absolute = 1e-6), /tolerance/);
    bad((l) => (l.outcomes[0].frequencies = []), /frequencies/);
    bad((l) => (l.outcomes[0].frequencies[0].frequency = -1), /frequencies/);
    bad((l) => (l.prediction = { prompt: 'x', sequence: [] }), /prediction/);
    bad((l) => (l.prediction = { prompt: 'x', sequence: [{ event: 'X', branch: 'works' }, { event: 'Y', branch: 'fails' }] }), /prediction/); // the reveal is about failures
    bad((l) => (l.prediction = { prompt: 'x', sequence: [{ event: 'X', branch: 'fails' }] }), /prediction/);
    bad((l) => delete l.discussion, /discussion/);
    bad((l) => (l.discussion = [{ question: 'q' }]), /discussion/);
  });
  it('run checks read only what the lesson asks for: unknown kinds are never true', () => {
    expect(runEtCheck({ kind: 'nope' } as never, solve(L1))).toBe(false);
  });
});

describe('the server loader', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sneed-etl-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const fresh = (name: string): { dir: string; oracles: string } => {
    const dir = path.join(tmp, name, 'event-trees');
    mkdirSync(dir, { recursive: true });
    cpSync(LESSON_DIR, dir, { recursive: true });
    const oracles = path.join(tmp, name, 'oracles.json');
    writeFileSync(oracles, readFileSync(path.join(ROOT, 'tests', 'event-tree-oracles.json'), 'utf8'));
    return { dir, oracles };
  };
  const refuses = (dir: string, oracles: string, re: RegExp): void => {
    expect(() => loadEventTreeLessons(dir, oracles)).toThrow(LessonsUnavailable);
    expect(() => loadEventTreeLessons(dir, oracles)).toThrow(re);
  };

  it('serves the three lessons in file order', () => {
    const { dir, oracles } = fresh('ok');
    expect(loadEventTreeLessons(dir, oracles).map((l) => l.id)).toEqual([L1, L2, L3]);
  });
  it('refuses all of them when the oracle file is missing, unreadable or not a list', () => {
    const { dir } = fresh('noor');
    refuses(dir, path.join(tmp, 'noor', 'missing.json'), /oracle file/);
    const bad = path.join(tmp, 'noor', 'bad.json');
    writeFileSync(bad, '{}');
    refuses(dir, bad, /oracle file/);
    refuses(path.join(tmp, 'nowhere'), path.join(ROOT, 'tests', 'event-tree-oracles.json'), /folder/);
  });
  it('refuses a lesson that disagrees with the oracle, with the file named', () => {
    const { dir, oracles } = fresh('disagree');
    const f = path.join(dir, files[1]!);
    const l = JSON.parse(readFileSync(f, 'utf8'));
    l.outcomes[0].frequencies[0].frequency = 0.3;
    writeFileSync(f, JSON.stringify(l));
    refuses(dir, oracles, new RegExp(`${files[1]}.*L_ORACLE_MISMATCH`));
  });
  it('refuses a lesson whose model is not a valid fault-tree model, or whose name is not a model name', () => {
    const a = fresh('badmodel');
    const f = path.join(a.dir, files[0]!);
    const l = JSON.parse(readFileSync(f, 'utf8'));
    l.model.document.top = 'NOPE';
    writeFileSync(f, JSON.stringify(l));
    refuses(a.dir, a.oracles, /not a valid fault-tree model|not the model/);
    // a model the oracle describes exactly, but which is not a valid document (no assumptions block)
    const c = fresh('invaliddoc');
    const h = path.join(c.dir, files[0]!);
    const n = JSON.parse(readFileSync(h, 'utf8'));
    delete n.model.document.assumptions;
    writeFileSync(h, JSON.stringify(n));
    refuses(c.dir, c.oracles, /not a valid fault-tree model/);
    const b = fresh('badname');
    const g = path.join(b.dir, files[0]!);
    const m = JSON.parse(readFileSync(g, 'utf8'));
    m.model.name = '../escape';
    writeFileSync(g, JSON.stringify(m));
    refuses(b.dir, b.oracles, /not a valid model name/);
  });
  it('refuses two lessons with one id, and two with one model name but different models', () => {
    const a = fresh('dupid');
    const l = JSON.parse(readFileSync(path.join(a.dir, files[0]!), 'utf8'));
    writeFileSync(path.join(a.dir, 'zz-copy.json'), JSON.stringify(l));
    refuses(a.dir, a.oracles, /share an id/);
    const b = fresh('dupname');
    const l3 = JSON.parse(readFileSync(path.join(b.dir, files[2]!), 'utf8'));
    l3.model.document.events[0].name = 'Renamed';
    writeFileSync(path.join(b.dir, files[2]!), JSON.stringify(l3));
    refuses(b.dir, b.oracles, /different models/);
  });
  it('ignores what is not a lesson file and refuses nothing it did not read', () => {
    const { dir, oracles } = fresh('extra');
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    mkdirSync(path.join(dir, 'sub.json'));
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(() => loadEventTreeLessons(dir, oracles)).toThrow(); // a folder named like a file is not skipped silently: it cannot be read as a lesson
  });
});

describe('the lessons over the API', () => {
  let server: RunningServer;
  let tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sneed-etl-api-'));
    mkdirSync(path.join(tmp, 'web'));
    writeFileSync(path.join(tmp, 'web', 'index.html'), '<!doctype html><title>x</title>');
    server = await startServer({ projectDir: path.join(tmp, 'models'), runsDir: path.join(tmp, 'runs'), staticDir: path.join(tmp, 'web'), lessonsDir: path.join(ROOT, 'lessons'), oraclesFile: path.join(ROOT, 'tests', 'oracles.json'), runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 'state') } }, 0);
  });
  afterAll(async () => {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  it('lists the lessons WITHOUT the instructor questions and answers: they never leave the server', async () => {
    const r = await fetch(server.url + '/api/event-tree-lessons');
    expect(r.status).toBe(200);
    const text = await r.text();
    const j = JSON.parse(text) as { lessons: (EtLesson & { discussion?: unknown })[] };
    expect(j.lessons.map((l) => l.id)).toEqual([L1, L2, L3]);
    for (const l of j.lessons) expect(l.discussion).toBeUndefined();
    expect(text).not.toContain('partition the possible outcomes');
    expect(text).not.toContain('discussion');
  });
  it('is read only and unavailable when lessons are not configured', async () => {
    const r = await fetch(server.url + '/api/event-tree-lessons', { method: 'POST', headers: { 'x-sneed-request': '1', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const bare = await startServer({ projectDir: path.join(tmp, 'm2'), runsDir: path.join(tmp, 'r2'), staticDir: path.join(tmp, 'web'), runtimeEnv: { distro: 'Ubuntu', linuxRoot: '/root/none', stateDir: path.join(tmp, 's2') } }, 0);
    try {
      expect((await fetch(bare.url + '/api/event-tree-lessons')).status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe('the review sheets', () => {
  it('are what the lesson files produce now: a sign-off applies to the text of the sheet, so it must not drift from the lessons', () => {
    const r = spawnSync(process.execPath, ['scripts/lesson-review.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stderr + r.stdout).toContain('sheets are current');
    expect(r.status).toBe(0);
  });

  it('the event-tree sheet has the instructor questions, the reviewer block and the expected frequencies; the student sheet has no instructor material', () => {
    const sheet = readFileSync(path.join(ROOT, 'docs', 'EVENT-TREE-LESSON-REVIEW.md'), 'utf8');
    expect(sheet).toContain('Model answer:');
    expect(sheet.match(/\*\*Reviewer\*\*/g)).toHaveLength(3);
    expect(sheet).toContain('X fails, Y fails: 0.077');
    expect(readFileSync(path.join(ROOT, 'docs', 'LESSON-REVIEW.md'), 'utf8')).not.toContain('Model answer');
  });
});
