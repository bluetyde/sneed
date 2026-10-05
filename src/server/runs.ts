// Read-only access to the saved run folders (runs/<id>/{native/model.json, results.json}) for the Compare view.
// An id is a plain folder name; the resolved path must stay directly inside the runs folder. Nothing here writes.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_LISTED_RUNS = 100;

export class RunsError extends Error {
  constructor(
    readonly code: 'E_NAME' | 'E_NOT_FOUND' | 'E_UNREADABLE',
    message: string,
  ) {
    super(message);
  }
}

export interface RunInfo {
  id: string;
  modified: string;
  status: string | null;
  completeness: string | null;
  method: string | null;
  top_event_probability: number | null;
  model_name: string | null;
  model_hash: string | null;
}

export const isValidRunId = (id: string): boolean => typeof id === 'string' && RUN_ID.test(id) && !id.includes('..') && !id.endsWith('.');

function runDir(dir: string, id: string): string {
  if (!isValidRunId(id)) throw new RunsError('E_NAME', 'not a run id');
  const d = path.resolve(dir, id);
  if (path.dirname(d) !== path.resolve(dir)) throw new RunsError('E_NAME', 'not a run id');
  return d;
}

/**
 * A file inside the runs folder, reached without following a link: every part of the path below the runs folder must be a
 * real file or folder (not a symlink or junction), and the real location must still be inside the runs folder. Throws otherwise.
 */
function plainPath(dir: string, ...parts: string[]): string {
  const root = realpathSync(path.resolve(dir));
  let cur = path.resolve(dir);
  for (const part of parts) {
    cur = path.join(cur, part);
    if (lstatSync(cur).isSymbolicLink()) throw new Error('a link');
  }
  const real = realpathSync(cur);
  if (real !== root && !real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error('outside the runs folder');
  return cur;
}

function readJsonFile(file: string): unknown {
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('missing or too large');
  return JSON.parse(readFileSync(file, 'utf8'));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The newest saved runs. A run whose files cannot be read is left out, never an error for the rest. */
export function listRuns(dir: string): RunInfo[] {
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter(isValidRunId).sort().reverse().slice(0, MAX_LISTED_RUNS * 2);
  const out: RunInfo[] = [];
  for (const id of ids) {
    if (out.length >= MAX_LISTED_RUNS) break;
    const d = path.join(dir, id);
    try {
      const rec = readJsonFile(plainPath(dir, id, 'results.json'));
      if (!isObj(rec) || rec.schema_version !== 1) continue;
      let model_name: string | null = null;
      try {
        const m = readJsonFile(plainPath(dir, id, 'native', 'model.json'));
        if (isObj(m) && isObj(m.model) && typeof m.model.name === 'string') model_name = m.model.name.slice(0, 200);
      } catch {
        /* the model file is optional for the list */
      }
      const hashes = isObj(rec.input_hashes) ? rec.input_hashes : {};
      out.push({
        id,
        modified: statSync(path.join(d, 'results.json')).mtime.toISOString(),
        status: typeof rec.status === 'string' ? rec.status : null,
        completeness: typeof rec.completeness === 'string' ? rec.completeness : null,
        method: typeof rec.method === 'string' ? rec.method : null,
        top_event_probability: typeof rec.top_event_probability === 'number' && Number.isFinite(rec.top_event_probability) ? rec.top_event_probability : null,
        model_name,
        model_hash: typeof hashes.model_hash === 'string' ? hashes.model_hash : null,
      });
    } catch {
      /* not a readable run */
    }
  }
  return out;
}

/** One run: the model text exactly as it was submitted and the results record. */
export function readRun(dir: string, id: string): { id: string; model_text: string; record: unknown } {
  const d = runDir(dir, id);
  if (!existsSync(d)) throw new RunsError('E_NOT_FOUND', `no saved run called ${id}`);
  try {
    const record = readJsonFile(plainPath(dir, id, 'results.json'));
    const modelFile = plainPath(dir, id, 'native', 'model.json');
    if (statSync(modelFile).size > MAX_FILE_BYTES) throw new Error('too large');
    const model_text = readFileSync(modelFile, 'utf8');
    JSON.parse(model_text); // the model of a run is a JSON document; anything else is not served
    return { id, model_text, record };
  } catch {
    throw new RunsError('E_UNREADABLE', `the files of run ${id} cannot be read`);
  }
}
