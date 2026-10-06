// Publication scrub of a folder of run files (or any text files): removes absolute folders of this machine and the account name.
//
//   npx tsx scripts/scrub.ts <folder> [--repo <project folder>] [--run <run folder>]...   report only (exit 1 if anything would change)
//   npx tsx scripts/scrub.ts <folder> --write ...                                       rewrite the files in place
//
// --repo names the project folder (replaced by <repo>), each --run a run folder (replaced by <run>). The account name of whoever runs this
// is always removed, and any /mnt/c/Users/<name>, C:\Users\<name>, /Users/<name> or /home/<name> becomes <user>. Links are never followed,
// binary files and files over 16 MB are left alone and reported, nothing is deleted. A file is replaced only after the new text is complete.
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountNames, findLeaks, scrubText, type ScrubOptions } from '../src/core/scrub.js';

const MAX_BYTES = 16 * 1024 * 1024;

export interface ScrubReport {
  scanned: number;
  changed: string[];
  skipped: { file: string; why: string }[];
  /** After scrubbing, anything the detector still finds (should be empty). */
  remaining: { file: string; match: string }[];
}

export function scrubFolder(root: string, opts: ScrubOptions, write: boolean): ScrubReport {
  const report: ScrubReport = { scanned: 0, changed: [], skipped: [], remaining: [] };
  // a link as the folder itself would be followed by the directory listing: refuse it, like every link below it
  if (lstatSync(root).isSymbolicLink()) throw new Error(`${root} is a link; give the real folder (links are never followed)`);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const file = path.join(dir, name);
      const st = lstatSync(file);
      if (st.isSymbolicLink()) {
        report.skipped.push({ file, why: 'a link (never followed)' });
        continue;
      }
      if (st.isDirectory()) {
        walk(file);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_BYTES) {
        report.skipped.push({ file, why: 'larger than 16 MB' });
        continue;
      }
      const bytes = readFileSync(file);
      if (bytes.includes(0)) {
        report.skipped.push({ file, why: 'binary' });
        continue;
      }
      report.scanned++;
      const text = bytes.toString('utf8');
      const clean = scrubText(text, opts);
      if (clean !== text) {
        report.changed.push(file);
        if (write) {
          const tmp = `${file}.scrub-${process.pid}.tmp`;
          writeFileSync(tmp, clean, { flag: 'wx' });
          renameSync(tmp, file);
        }
      }
      for (const l of findLeaks(clean, { usernames: opts.usernames ?? [] })) report.remaining.push({ file, match: l.match });
    }
  };
  walk(root);
  return report;
}

function main(argv: string[]): number {
  const args = [...argv];
  const write = args.includes('--write');
  const take = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]!);
    return out;
  };
  const folder = args.find((a, i) => !a.startsWith('--') && !['--repo', '--run'].includes(args[i - 1] ?? ''));
  if (!folder || !existsSync(folder)) {
    console.error('usage: scrub.ts <folder> [--write] [--repo <project folder>] [--run <run folder>]...');
    return 2;
  }
  const prefixes: [string, string][] = [...take('--repo').map((p): [string, string] => [path.resolve(p), '<repo>']), ...take('--run').map((p): [string, string] => [path.resolve(p), '<run>'])];
  const r = scrubFolder(folder, { prefixes, usernames: accountNames() }, write);
  console.log(`${r.scanned} files scanned; ${r.changed.length} ${write ? 'rewritten' : 'would change'}; ${r.skipped.length} skipped`);
  for (const f of r.changed.slice(0, 20)) console.log(`  ${write ? 'scrubbed' : 'needs scrub'}: ${path.relative(folder, f) || f}`);
  if (r.changed.length > 20) console.log(`  ... and ${r.changed.length - 20} more`);
  for (const s of r.skipped) console.log(`  skipped ${path.relative(folder, s.file)}: ${s.why}`);
  for (const x of r.remaining.slice(0, 20)) console.log(`  STILL FOUND in ${path.relative(folder, x.file)}: ${x.match}`);
  if (r.remaining.length) return 1;
  return write || r.changed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
