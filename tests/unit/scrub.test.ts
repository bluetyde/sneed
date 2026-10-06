import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

  it('finds a folder given in one style when the text uses another, and ignores case as Windows does', () => {
    const opts = { prefixes: [['C:/Users/frank/proj', '<repo>']] as [string, string][] };
    expect(scrubText(`in C:${B}Users${B}frank${B}proj${B}x.xml`, opts)).toBe(`in <repo>${B}x.xml`);
    expect(scrubText(`in c:${B}users${B}FRANK${B}Proj${B}x.xml`, opts)).toBe(`in <repo>${B}x.xml`);
  });

  it('a folder with characters special to regular expressions is replaced literally', () => {
    const odd = 'C:/work/a.b (copy)/[x]+y';
    expect(scrubText(`in ${odd}/z and C:/work/aXb (copy)/[x]+y`, { prefixes: [[odd, '<repo>']] })).toBe('in <repo>/z and C:/work/aXb (copy)/[x]+y');
  });

  it('turns any home folder into <user>, in the Windows, WSL, macOS and Linux spellings, but leaves example names', () => {
    expect(scrubText(`C:${B}Users${B}zed smith${B}x`)).toBe(`C:${B}Users${B}<user>${B}x`); // a name with a space is taken whole when a separator follows
    expect(scrubText('/mnt/d/Users/carol/p/q')).toBe('/mnt/d/Users/<user>/p/q');
    expect(scrubText('C:/Users/carol/p')).toBe('C:/Users/<user>/p');
    expect(scrubText(`"C:${B}${B}Users${B}${B}carol${B}${B}p"`)).toBe(`"C:${B}${B}Users${B}${B}<user>${B}${B}p"`);
    expect(scrubText('see /Users/carol/Documents and (/home/carol/x)')).toBe('see /Users/<user>/Documents and (/home/<user>/x)');
    expect(scrubText('mkdir /home/student/work /Users/alice/x C:/Users/user/y')).toBe('mkdir /home/student/work /Users/alice/x C:/Users/user/y');
  });

  it('removes the given account names wherever they appear as a whole word, in any case, and never from other words', () => {
    expect(scrubText('owner=Carol123 CAROL123 carol1234 xcarol123', { usernames: ['carol123'] })).toBe('owner=<user> <user> carol1234 xcarol123');
    // an account name that is given is removed whatever it looks like: a real account may be called `student` or be two letters long
    expect(scrubText('ab is short', { usernames: ['ab'] })).toBe('<user> is short');
    expect(scrubText('owner=alice C:/Users/alice/work', { usernames: ['alice'] })).toBe('owner=<user> C:/Users/<user>/work');
    expect(findLeaks('owner=alice', { usernames: ['alice'] })).toHaveLength(1);
    expect(findLeaks('owner=ab', { usernames: ['ab'] })).toHaveLength(1);
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

describe('account names with spaces, encoded names, case and file URLs', () => {
  it('a name with a space is removed whole, plain or as %20, before a path pattern could cut it', () => {
    expect(scrubText('C:/Users/Zed Smith/work', { usernames: ['Zed Smith'] })).toBe('C:/Users/<user>/work');
    expect(scrubText('file:///C:/Users/Zed%20Smith/work', { usernames: ['Zed Smith'] })).toBe('file:///C:/Users/<user>/work');
    expect(scrubText('by zed smith', { usernames: ['Zed Smith'] })).toBe('by <user>');
    expect(findLeaks('file:///C:/Users/Zed%20Smith/work', { usernames: ['Zed Smith'] }).length).toBeGreaterThan(0);
  });

  it('a home folder with a spaced name is taken whole even when the name is not known', () => {
    expect(scrubText('C:/Users/Zed Smith/work')).toBe('C:/Users/<user>/work');
    expect(scrubText('/mnt/c/Users/Zed Smith/My Docs/x')).toBe('/mnt/c/Users/<user>/My Docs/x');
    expect(scrubText('file:///C:/Users/Zed%20Smith/work')).toBe('file:///C:/Users/<user>/work');
  });

  it('prose after a bare home folder is left alone, and a name is never longer than three words', () => {
    expect(scrubText('see C:/Users/carol is where it went')).toBe('see C:/Users/<user> is where it went');
    expect(scrubText('C:/Users/one two three four/x')).toBe('C:/Users/<user> two three four/x'); // more than three words is not taken as one name: only its first word is
  });

  it('Windows folder names are matched whatever their case, and file URLs of POSIX home folders are found', () => {
    expect(scrubText('c:/users/carol/work')).toBe('c:/users/<user>/work');
    expect(scrubText('C:\\USERS\\Carol\\work')).toBe('C:\\USERS\\<user>\\work');
    expect(scrubText('file:///home/carol/work')).toBe('file:///home/<user>/work');
    expect(scrubText('file:///Users/carol/work')).toBe('file:///Users/<user>/work');
    expect(findLeaks('file:///home/carol/work')).toHaveLength(1);
    expect(findLeaks('c:/users/carol/work')).toHaveLength(1);
  });

  it('the account names of this process leave out system accounts such as root, which is also a folder in every WSL path', () => {
    const saved = { u: process.env.USERNAME, n: process.env.USER, l: process.env.LOGNAME };
    try {
      process.env.USERNAME = 'root';
      process.env.USER = 'Administrator';
      process.env.LOGNAME = 'somebody';
      const names = accountNames();
      expect(names).toContain('somebody');
      expect(names.map((n) => n.toLowerCase())).not.toContain('root');
      expect(names.map((n) => n.toLowerCase())).not.toContain('administrator');
    } finally {
      for (const [k, v] of [['USERNAME', saved.u], ['USER', saved.n], ['LOGNAME', saved.l]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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

describe('the command line', () => {
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'scrub.ts'), ...args], { encoding: 'utf8', cwd: ROOT });

  it('really runs when started as a script (not only when imported): reports, then rewrites, with matching exit codes', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'sneed-scrub-cli-'));
    try {
      writeFileSync(path.join(d, 'a.log'), 'File: /mnt/c/Users/zelda/p/in.xml\n');
      const dry = run([d]);
      expect(dry.status, dry.stdout + dry.stderr).toBe(1); // something would change
      expect(dry.stdout).toContain('1 would change');
      expect(readFileSync(path.join(d, 'a.log'), 'utf8')).toContain('zelda');
      const done = run([d, '--write']);
      expect(done.status, done.stdout + done.stderr).toBe(0);
      expect(readFileSync(path.join(d, 'a.log'), 'utf8')).toBe('File: /mnt/c/Users/<user>/p/in.xml\n');
      expect(run([d]).status).toBe(0); // clean now
      expect(run([path.join(d, 'missing')]).status).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60000);

  it('refuses a folder that is itself a link, and writes nothing through it', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'sneed-scrub-root-'));
    try {
      mkdirSync(path.join(d, 'real'));
      writeFileSync(path.join(d, 'real', 'a.log'), '/mnt/c/Users/zelda/x');
      try {
        symlinkSync(path.join(d, 'real'), path.join(d, 'link'), 'junction');
      } catch {
        return; // links cannot be made here
      }
      expect(() => scrubFolder(path.join(d, 'link'), {}, true)).toThrow(/is a link/);
      expect(readFileSync(path.join(d, 'real', 'a.log'), 'utf8')).toBe('/mnt/c/Users/zelda/x');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
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
      if (f === 'tests/unit/scrub.test.ts') continue; // its fixtures are deliberate fake leaks (made-up names), the only file allowed to hold them
      const full = path.join(ROOT, f);
      if (!existsSync(full)) continue;
      const bytes = readFileSync(full);
      if (bytes.includes(0) || bytes.length > 8 * 1024 * 1024) continue;
      for (const l of findLeaks(bytes.toString('utf8'), { usernames: names })) found.push(`${f}: ${l.kind} ${l.match}`);
    }
    expect(found, 'run `npx tsx scripts/scrub.ts <folder> --write` on the folder, or fix the file by hand').toEqual([]);
  });
});
