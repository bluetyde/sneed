import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, lstatSync, writeFileSync, existsSync, unlinkSync, linkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** A model name is a plain file stem: no separators, no leading dot, at most 64 characters. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Largest model file the server will read or write. */
export const MAX_MODEL_BYTES = 2 * 1024 * 1024;

export class StorageError extends Error {
  constructor(
    readonly code: 'E_NAME' | 'E_NOT_FOUND' | 'E_TOO_LARGE' | 'E_NOT_JSON' | 'E_EXISTS' | 'E_LINK',
    message: string,
  ) {
    super(message);
  }
}

export interface ModelInfo {
  name: string;
  bytes: number;
  modified: string;
}

export function isValidModelName(name: string): boolean {
  return typeof name === 'string' && MODEL_NAME.test(name) && !name.endsWith('.') && !name.includes('..');
}

/**
 * The storage folder and every file in it must be what they say: a real folder and real files, never a symbolic link or a junction, which
 * would let a name inside the folder lead outside it. The caller names the folder by its real path (the project folder is the user's own
 * choice and may itself be reached through a link: resolve it once, then pass that). A swap between this check and the use is a
 * documented limit (Node has no no-follow open on Windows); the point is to refuse a link that is already there.
 */
function plainFolder(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // not made yet: nothing to follow
    throw e;
  }
  // lstat does not follow a link, so a link (symbolic or junction) is neither a directory nor a file here
  if (!st.isDirectory()) throw new StorageError('E_LINK', 'the storage folder is a link or not a folder, so it is not used');
}
function plainFile(file: string): void {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // a new file
    throw e;
  }
  if (!st.isFile()) throw new StorageError('E_LINK', 'the saved file is a link or not a plain file, so it is not used');
}

function fileFor(dir: string, name: string): string {
  if (!isValidModelName(name)) throw new StorageError('E_NAME', 'a model name is letters, digits, dot, dash or underscore, starting with a letter or digit');
  const file = path.resolve(dir, `${name}.json`);
  // the resolved path must stay directly inside the project folder
  if (path.dirname(file) !== path.resolve(dir)) throw new StorageError('E_NAME', 'a model name cannot contain a path');
  plainFolder(dir);
  plainFile(file);
  return file;
}

/** The saved models in the project folder, newest first. A missing folder is an empty list, not an error. */
export function listModels(dir: string): ModelInfo[] {
  if (!existsSync(dir)) return [];
  plainFolder(dir);
  const out: ModelInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    if (!isValidModelName(name)) continue;
    const st = lstatSync(path.join(dir, f)); // a link is not listed
    if (!st.isFile()) continue;
    out.push({ name, bytes: st.size, modified: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
}

export function readModel(dir: string, name: string): string {
  const file = fileFor(dir, name);
  if (!existsSync(file)) throw new StorageError('E_NOT_FOUND', `no saved model called ${name}`);
  if (statSync(file).size > MAX_MODEL_BYTES) throw new StorageError('E_TOO_LARGE', 'the saved model is larger than the allowed size');
  return readFileSync(file, 'utf8');
}

/**
 * Saves an imported model with what it came from, beside it: <name>.json (the native model), <name>.opsa.xml (the original file,
 * byte for byte) and <name>.opsa-import.log (what the importer noted). The model is written last, so a model that exists is a
 * complete import; a failure removes what this call wrote. An existing model of that name is never replaced.
 */
export function writeImport(dir: string, name: string, files: { modelText: string; originalText: string; report: string }): ModelInfo {
  const model = fileFor(dir, name);
  if (existsSync(model)) throw new StorageError('E_EXISTS', `a model called ${name} already exists; choose another name`);
  for (const t of [files.modelText, files.originalText, files.report]) {
    if (Buffer.byteLength(t, 'utf8') > MAX_MODEL_BYTES) throw new StorageError('E_TOO_LARGE', 'the import is larger than the allowed size');
  }
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  // Publishing is a hard link, which fails when the name exists: another import of the same name (even in another process) is
  // never overwritten, and `written` holds only what THIS call created, so a rollback never removes anything that is not ours.
  const put = (file: string, text: string): void => {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
      try {
        linkSync(tmp, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('E_EXISTS', `${path.basename(file)} already exists; choose another name`);
        throw e;
      }
      written.push(file);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
  };
  try {
    put(path.resolve(dir, `${name}.opsa.xml`), files.originalText);
    put(path.resolve(dir, `${name}.opsa-import.log`), files.report);
    put(model, files.modelText);
  } catch (e) {
    const left: string[] = [];
    for (const f of written) {
      try {
        unlinkSync(f);
      } catch (u) {
        if ((u as NodeJS.ErrnoException).code !== 'ENOENT') left.push(path.basename(f));
      }
    }
    // say what could not be removed: it would block the next import of this name
    if (left.length && e instanceof StorageError) throw new StorageError(e.code, `${e.message}; these files of the failed import could not be removed: ${left.join(', ')}`);
    if (left.length) throw new Error(`${(e as Error).message}; these files of the failed import could not be removed: ${left.join(', ')}`);
    throw e;
  }
  const st = statSync(model);
  return { name, bytes: st.size, modified: st.mtime.toISOString() };
}

/** Saves the exact text given, atomically, so a crash never leaves a half-written model. The text must be valid JSON; it need not be a valid model, so work in progress is never lost. */
export function writeModel(dir: string, name: string, text: string): ModelInfo {
  const file = fileFor(dir, name);
  if (Buffer.byteLength(text, 'utf8') > MAX_MODEL_BYTES) throw new StorageError('E_TOO_LARGE', 'the model is larger than the allowed size');
  try {
    JSON.parse(text);
  } catch {
    throw new StorageError('E_NOT_JSON', 'the text is not valid JSON, so it was not saved');
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8' });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
  const st = statSync(file);
  return { name, bytes: st.size, modified: st.mtime.toISOString() };
}
