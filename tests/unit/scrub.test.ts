import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountNames, findLeaks, scrubText } from '../../src/core/scrub.js';
import { scrubFolder } from '../../scripts/scrub.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const B = '\\'; // one backslash

describe('scrubText', () => {
  it('replaces a named folder in every spelling a tool may have written', () => {
    const run = `C:${B}Users${B}alice${B}My Course${B}runs${B}r1`;
    const opts = { prefixes: [[run, '<run>']] as [string, string][] };
    for (const spelling of [run, 'C:/Users/alice/My Course/runs/r1', `C:${B}${B}Users${B}${B}alice${B}${B}My Course${B}${B}runs${B}${B}r1`, '/mnt/c/Users/alice/My Course/runs/r1', '/mnt/c/Users/alice/My%20Course/runs/r1']) {
      expect(scrubText(`File: ${spelling}/inputs/model.xml`, opts), spelling).toBe('File: <run>/inputs/model.xml');
    }
    expect(scrubText('no folder here', opts)).toBe('no folder here');
  });

  it('a folder with characters special to regular expressions is replaced literally', () => {
    const odd = 'C:/work/a.b (copy)/[x]+y';
    expect(scrubText(`in ${odd}/z and C:/work/aXb (copy)/[x]+y`, { prefixes: [[odd, '<repo>']] })).toBe('in <repo>/z and C:/work/aXb (copy)/[x]+y');
  });

  it('turns any home folder into <user>, in the Windows, WSL, macOS and Linux spellings, but leaves example names', () => {
    expect(scrubText(`C:${B}Users${B}zed smith${B}x`)).toBe(`C:${B}Users${B}<user> smith${B}x`); // a name stops at a space
    expect(scrubText('/mnt/d/Users/carol/p/q')).toBe('/mnt/d/Users/<user>/p/q');
    expect(scrubText('C:/Users/carol/p')).toBe('C:/Users/<user>/p');
    expect(scrubText(`"C:${B}${B}Users${B}${B}carol${B}${B}p"`)).toBe(`"C:${B}${B}Users${B}${B}<user>${B}${B}p"`);
    expect(scrubText('see /Users/carol/Documents and (/home/carol/x)')).toBe('see /Users/<user>/Documents and (/home/<user>/x)');
    expect(scrubText('mkdir /home/student/work /Users/alice/x C:/Users/user/y')).toBe('mkdir /home/student/work /Users/alice/x C:/Users/user/y');
  });

  it('removes the given account names wherever they appear as a whole word, in any case, and never from other words', () => {
    expect(scrubText('owner=Carol123 CAROL123 carol1234 xcarol123', { usernames: ['carol123'] })).toBe('owner=<user> <user> carol1234 xcarol123');
    expect(scrubText('ab is short', { usernames: ['ab'] })).toBe('ab is short'); // a name that short would be taken out of ordinary words
    expect(scrubText('student here', { usernames: ['student'] })).toBe('student here'); // an example name is not a person
  });

  it('is idempotent, and never changes text that has nothing to scrub', () => {
    const opts = { prefixes: [['C:/Users/dave/proj', '<repo>']] as [string, string][], usernames: ['dave'] };
    const text = 'a /mnt/c/Users/dave/proj/x and dave and /home/dave/y\n{"k": "C:\\\\Users\\\\dave\\\\proj"}';
    const once = scrubText(text, opts);
    expect(scrubText(once, opts)).toBe(once);
    expect(once).not.toMatch(/dave/);
    const clean = 'probability 0.19 at /root/sneed-runtime/scram and <run>/inputs/model.xml';
    expect(scrubText(clean, opts)).toBe(clean);
  });

  it('keeps JSON valid: a scrubbed JSON document still parses to the same structure', () => {
    const doc = { argv: ['/mnt/c/Users/erin/p/in.xml', 'C:\\Users\\erin\\p\\out.xml'], stderr: 'File: /mnt/c/Users/erin/My%20Folder/p/in.xml\n' };
    const scrubbed = JSON.parse(scrubText(JSON.stringify(doc), { usernames: ['erin'] }));
    expect(scrubbed).toEqual({ argv: ['/mnt/c/Users/<user>/p/in.xml', 'C:\\Users\\<user>\\p\\out.xml'], stderr: 'File: /mnt/c/Users/<user>/My%20Folder/p/in.xml\n' });
  });
});

describe('findLeaks', () => {
  it('finds home folders and account names, and nothing in clean text', () => {
    expect(findLeaks('x /mnt/c/Users/frank/y')).toEqual([expect.objectContaining({ kind: 'user-folder', match: '/mnt/c/Users/frank' })]);
    expect(findLeaks('by gina here', { usernames: ['gina'] })).toEqual([expect.objectContaining({ kind: 'username', match: 'gina' })]);
    expect(findLeaks('/mnt/c/Users/<user>/p /home/student/x C:/Users/alice/y plain text', { usernames: ['gina'] })).toEqual([]);
  });

  it('whatever scrubText produces has no leaks left', () => {
    const texts = ['/mnt/c/Users/hal/a', 'C:\\Users\\hal\\a', 'C:/Users/hal/a', '/home/hal/a', '/Users/hal/a', 'hal wrote it', 'x=/mnt/c/Users/hal/My%20Docs/p'];
    for (const t of texts) expect(findLeaks(scrubText(t, { usernames: ['hal'] }), { usernames: ['hal'] }), t).toEqual([]);
  });
});

describe('the scrub tool on a folder', () => {
  const dirs: string[] = [];
  const temp = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'sneed-scrub-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reports without writing, then rewrites only the files that change, leaving the rest byte for byte', () => {
    const d = temp();
    mkdirSync(path.join(d, 'sub'));
    writeFileSync(path.join(d, 'a.json'), '{"p":"/mnt/c/Users/ivan/x"}');
    writeFileSync(path.join(d, 'sub', 'b.txt'), 'File: C:/Users/ivan/x/in.xml\r\n');
    writeFileSync(path.join(d, 'clean.txt'), 'nothing here\r\n');
    const dry = scrubFolder(d, { usernames: ['ivan'] }, false);
    expect(dry).toMatchObject({ scanned: 3, remaining: [] });
    expect(dry.changed.map((f) => path.basename(f)).sort()).toEqual(['a.json', 'b.txt']);
    expect(readFileSync(path.join(d, 'a.json'), 'utf8')).toContain('ivan'); // a dry run writes nothing
    const done = scrubFolder(d, { usernames: ['ivan'] }, true);
    expect(done.changed).toHaveLength(2);
    expect(readFileSync(path.join(d, 'a.json'), 'utf8')).toBe('{"p":"/mnt/c/Users/<user>/x"}');
    expect(readFileSync(path.join(d, 'sub', 'b.txt'), 'utf8')).toBe('File: C:/Users/<user>/x/in.xml\r\n'); // line endings kept
    expect(readFileSync(path.join(d, 'clean.txt'), 'utf8')).toBe('nothing here\r\n');
    expect(scrubFolder(d, { usernames: ['ivan'] }, false).changed).toEqual([]); // nothing left to do
    expect(existsSync(path.join(d, 'a.json.scrub-1.tmp'))).toBe(false);
  });

  it('replaces the named project and run folders by their placeholders', () => {
    const d = temp();
    const repo = path.join(d, 'proj');
    writeFileSync(path.join(d, 'r.json'), JSON.stringify({ a: `${repo.replace(/\\/g, '/')}/docs/x`, b: repo }));
    scrubFolder(d, { prefixes: [[repo, '<repo>']] }, true);
    expect(JSON.parse(readFileSync(path.join(d, 'r.json'), 'utf8'))).toEqual({ a: '<repo>/docs/x', b: '<repo>' });
  });

  it('skips binary files and links, and never follows a link out of the folder', () => {
    const d = temp();
    const outside = temp();
    writeFileSync(path.join(outside, 'secret.txt'), '/mnt/c/Users/jan/outside');
    writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 1, 2, ...Buffer.from('/mnt/c/Users/jan/x')]));
    let linked = true;
    try {
      symlinkSync(outside, path.join(d, 'link'), 'junction');
    } catch {
      linked = false;
    }
    const r = scrubFolder(d, { usernames: ['jan'] }, true);
    expect(r.skipped.some((s) => s.why === 'binary')).toBe(true);
    if (linked) expect(r.skipped.some((s) => s.why.startsWith('a link'))).toBe(true);
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('/mnt/c/Users/jan/outside'); // untouched
    expect(readFileSync(path.join(d, 'bin.dat')).includes(Buffer.from('jan'))).toBe(true);
  });
});

describe('the repository itself is fit to publish', () => {
  const tracked = (): string[] => {
    try {
      return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    } catch {
      return []; // not a git checkout (an archive): nothing to list
    }
  };

  it('no tracked text file names a home folder or the account running this test', () => {
    const files = tracked();
    const names = accountNames();
    const found: string[] = [];
    for (const f of files) {
      const full = path.join(ROOT, f);
      if (!existsSync(full)) continue;
      const bytes = readFileSync(full);
      if (bytes.includes(0) || bytes.length > 8 * 1024 * 1024) continue;
      for (const l of findLeaks(bytes.toString('utf8'), { usernames: names })) found.push(`${f}: ${l.kind} ${l.match}`);
    }
    expect(found, 'run `npx tsx scripts/scrub.ts <folder> --write` on the folder, or fix the file by hand').toEqual([]);
  });
});
