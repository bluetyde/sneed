// Reads the lesson files and refuses to serve any that fail validation, or all of them if the oracle file they are checked
// against is missing: a lesson with an unchecked value must never reach a student (docs/plans/04-lessons.md).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadLesson, LessonError, type Lesson, type OracleEntry } from '../core/lesson.js';

export class LessonsUnavailable extends Error {
  readonly code = 'E_LESSONS_UNAVAILABLE';
}

export function loadLessons(dir: string, oraclesFile: string): Lesson[] {
  let oracles: OracleEntry[];
  try {
    oracles = JSON.parse(readFileSync(oraclesFile, 'utf8')) as OracleEntry[];
    if (!Array.isArray(oracles)) throw new Error('not a list');
    // the common-cause oracles (plan 15) sit beside the others; a lesson may name an entry of either file
    const ccFile = path.join(path.dirname(oraclesFile), 'oracles-common-cause.json');
    if (existsSync(ccFile)) {
      const cc = JSON.parse(readFileSync(ccFile, 'utf8')) as OracleEntry[];
      if (!Array.isArray(cc)) throw new Error('the common-cause oracle file is not a list');
      oracles = [...oracles, ...cc];
    }
  } catch (e) {
    throw new LessonsUnavailable(`the oracle file the lessons are checked against cannot be read (${(e as Error).message})`);
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    throw new LessonsUnavailable('the lessons folder cannot be read');
  }
  const out: Lesson[] = [];
  for (const f of files) {
    try {
      out.push(loadLesson(readFileSync(path.join(dir, f), 'utf8'), oracles));
    } catch (e) {
      const why = e instanceof LessonError ? `${e.code}: ${e.message}` : (e as Error).message;
      throw new LessonsUnavailable(`lesson file ${f} is refused (${why})`);
    }
  }
  const ids = out.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new LessonsUnavailable('two lesson files share an id');
  return out;
}
