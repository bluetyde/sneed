// Reads the event-tree lesson files and refuses to serve any that fail validation, or all of them if the oracle file they are checked against is
// missing: a lesson with an unchecked value must never reach a student (docs/plans/04-lessons.md, 13-event-trees.md stage S5).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EtLessonError, lessonAgainstOracles, parseEtLesson, type EtLesson, type EtOracleEntry } from '../core/event-tree-lesson.js';
import { validateModelText } from '../core/validate.js';
import { isValidModelName } from './storage.js';
import { LessonsUnavailable } from './lessons.js';

export function loadEventTreeLessons(dir: string, oraclesFile: string): EtLesson[] {
  let oracles: EtOracleEntry[];
  try {
    oracles = JSON.parse(readFileSync(oraclesFile, 'utf8')) as EtOracleEntry[];
    if (!Array.isArray(oracles)) throw new Error('not a list');
  } catch (e) {
    throw new LessonsUnavailable(`the oracle file the event-tree lessons are checked against cannot be read (${(e as Error).message})`);
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    throw new LessonsUnavailable('the event-tree lessons folder cannot be read');
  }
  const out: EtLesson[] = [];
  for (const f of files) {
    try {
      const lesson = parseEtLesson(readFileSync(path.join(dir, f), 'utf8'));
      if (!isValidModelName(lesson.model.name)) throw new EtLessonError('L_BAD_MODEL', `the model name ${JSON.stringify(lesson.model.name)} is not a valid model name`);
      const v = validateModelText(JSON.stringify(lesson.model.document));
      if (!v.valid) throw new EtLessonError('L_BAD_MODEL', `the model of the lesson is not a valid fault-tree model (${v.errors.map((x) => x.code).join(', ')})`);
      const why = lessonAgainstOracles(lesson, oracles);
      if (why) throw new EtLessonError(why.code, why.message);
      out.push(lesson);
    } catch (e) {
      const why = e instanceof EtLessonError ? `${e.code}: ${e.message}` : (e as Error).message;
      throw new LessonsUnavailable(`event-tree lesson file ${f} is refused (${why})`);
    }
  }
  const ids = out.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new LessonsUnavailable('two event-tree lesson files share an id');
  // two lessons may share one model name only if they ship the same model: starting either must leave the other's model as it was
  const byName = new Map<string, string>();
  for (const l of out) {
    const doc = JSON.stringify(l.model.document);
    if (byName.has(l.model.name) && byName.get(l.model.name) !== doc) throw new LessonsUnavailable(`two event-tree lessons use the model name ${l.model.name} with different models`);
    byName.set(l.model.name, doc);
  }
  return out;
}
