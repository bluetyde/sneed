import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** A model name is a plain file stem: no separators, no leading dot, at most 64 characters. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Largest model file the server will read or write. */
export const MAX_MODEL_BYTES = 2 * 1024 * 1024;

export class StorageError extends Error {
  constructor(
    readonly code: 'E_NAME' | 'E_NOT_FOUND' | 'E_TOO_LARGE' | 'E_NOT_JSON',
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

function fileFor(dir: string, name: string): string {
  if (!isValidModelName(name)) throw new StorageError('E_NAME', 'a model name is letters, digits, dot, dash or underscore, starting with a letter or digit');
  const file = path.resolve(dir, `${name}.json`);
  // the resolved path must stay directly inside the project folder
  if (path.dirname(file) !== path.resolve(dir)) throw new StorageError('E_NAME', 'a model name cannot contain a path');
  return file;
}

/** The saved models in the project folder, newest first. A missing folder is an empty list, not an error. */
export function listModels(dir: string): ModelInfo[] {
  if (!existsSync(dir)) return [];
  const out: ModelInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    if (!isValidModelName(name)) continue;
    const st = statSync(path.join(dir, f));
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
