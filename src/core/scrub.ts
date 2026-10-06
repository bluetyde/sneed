// Publication scrub: what a run folder may say about the machine it ran on. Nothing a person would not want to publish is written into
// run files: no absolute path of the project, the run folder or a home folder, and no account name. Pure text in, text out; used when
// the app writes run files (analyze.ts) and by `scripts/scrub.ts` for folders that already exist and for the guard test.
//
// Placeholders: <run> the run folder, <repo> the project folder, <user> an account name.

import { userInfo } from 'node:os';

/** The names of the account running this process, as the operating system and the environment give them. */
export function accountNames(): string[] {
  const names = new Set<string>();
  try {
    names.add(userInfo().username);
  } catch {
    /* no account information: the environment may still have it */
  }
  for (const n of [process.env.USERNAME, process.env.USER, process.env.LOGNAME]) if (n) names.add(n);
  return [...names];
}

/** Account names that are examples, not people: never reported, never replaced. */
const EXAMPLE_NAMES = new Set(['student', 'user', 'you', 'name', 'username', '<user>', 'alice', 'bob', 'example', 'x']);

const NAME = '[^\\\\/\\s"\'<>:*?|%$(){}\\[\\],;`]+'; // an account name in a path: no separators, spaces, markup or code punctuation
// drive-letter user folder in its several spellings (C:\Users\x, C:/Users/x, JSON-escaped C:\\Users\\x), and the WSL spelling
const WIN_USERS = new RegExp(`([A-Za-z]:(?:\\\\{1,2}|/)Users(?:\\\\{1,2}|/))(${NAME})`, 'g');
const MNT_USERS = new RegExp(`(/mnt/[a-z]/Users/)(${NAME})`, 'g');
const MAC_USERS = new RegExp(`(^|[\\s"'=(:])(/Users/)(${NAME})`, 'gm');
const HOME = new RegExp(`(^|[\\s"'=(:])(/home/)(${NAME})`, 'gm');

export interface ScrubOptions {
  /** Exact folders to replace, each with its placeholder, in every spelling a tool might have written (/, \, \\ and %20 for spaces). */
  prefixes?: [folder: string, placeholder: string][];
  /** Account names to remove wherever they appear (case-insensitive, whole word). */
  usernames?: string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every way a tool may have written the same folder. */
function spellings(folder: string): string[] {
  const fwd = folder.replace(/\\/g, '/');
  const out = new Set<string>([folder, fwd, fwd.replace(/\//g, '\\'), fwd.replace(/\//g, '\\\\')]);
  const drive = /^([A-Za-z]):\//.exec(fwd);
  if (drive) out.add(`/mnt/${drive[1]!.toLowerCase()}/${fwd.slice(3)}`); // the same folder as WSL names it
  for (const s of [...out]) out.add(s.replace(/ /g, '%20'));
  return [...out].filter((s) => s.length > 3).sort((a, b) => b.length - a.length); // longest first
}

export function scrubText(text: string, opts: ScrubOptions = {}): string {
  let out = text;
  for (const [folder, placeholder] of opts.prefixes ?? []) {
    if (!folder) continue;
    for (const s of spellings(folder)) out = out.replace(new RegExp(escapeRe(s), 'gi'), placeholder);
  }
  const keep = (name: string): boolean => EXAMPLE_NAMES.has(name.toLowerCase());
  out = out.replace(WIN_USERS, (m, a: string, n: string) => (keep(n) ? m : `${a}<user>`));
  out = out.replace(MNT_USERS, (m, a: string, n: string) => (keep(n) ? m : `${a}<user>`));
  out = out.replace(MAC_USERS, (m, pre: string, a: string, n: string) => (keep(n) ? m : `${pre}${a}<user>`));
  out = out.replace(HOME, (m, pre: string, a: string, n: string) => (keep(n) ? m : `${pre}${a}<user>`));
  for (const u of opts.usernames ?? []) {
    if (u.length < 3 || keep(u)) continue; // a one- or two-letter name would be removed from ordinary words
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(u)}(?![A-Za-z0-9])`, 'gi'), '<user>');
  }
  return out;
}

export interface Leak {
  kind: 'username' | 'user-folder';
  match: string;
  index: number;
}

/** What `scrubText` would still change: the leaks in a text. Empty means it is fit to publish (as far as this check can tell). */
export function findLeaks(text: string, opts: Pick<ScrubOptions, 'usernames'> = {}): Leak[] {
  const leaks: Leak[] = [];
  const keep = (name: string): boolean => EXAMPLE_NAMES.has(name.toLowerCase());
  for (const re of [WIN_USERS, MNT_USERS, MAC_USERS, HOME]) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const name = m[m.length - 1]!;
      if (!keep(name)) leaks.push({ kind: 'user-folder', match: m[0].trim(), index: m.index ?? 0 });
    }
  }
  for (const u of opts.usernames ?? []) {
    if (u.length < 3 || keep(u)) continue;
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${escapeRe(u)}(?![A-Za-z0-9])`, 'gi'))) leaks.push({ kind: 'username', match: m[0], index: m.index ?? 0 });
  }
  return leaks.sort((a, b) => a.index - b.index);
}
