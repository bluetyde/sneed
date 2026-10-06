import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD_ID_FILE, EXTRA_SOURCE_FILES, readEngineSources, renderBuildId, sourceHash, type SourceFile } from '../../scripts/lib/engine-id.js';
import { BDD_SOURCE_FILES, BDD_SOURCE_SHA256 } from '../../src/engines/bdd/build-id.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const f = (p: string, content: string): SourceFile => ({ path: p, content });

describe('the built-in engine has an identity: the hash of its source files', () => {
  it('the committed identity matches the sources: after changing the solver, run `npm run gen:engine-id`', () => {
    const files = readEngineSources(ROOT);
    expect(BDD_SOURCE_SHA256, 'the engine sources changed but build-id.ts was not regenerated (npm run gen:engine-id)').toBe(sourceHash(files));
    expect([...BDD_SOURCE_FILES]).toEqual(files.map((x) => x.path).sort());
    expect(readFileSync(path.join(ROOT, BUILD_ID_FILE), 'utf8')).toBe(renderBuildId(files)); // the whole generated file, byte for byte
  });

  it('covers every solver file, the importance code and the shared result checks, and not the generated file itself', () => {
    const list = [...BDD_SOURCE_FILES];
    for (const p of ['src/engines/bdd/bdd.ts', 'src/engines/bdd/solve.ts', 'src/engines/bdd/analyze.ts', 'src/engines/bdd/importance.ts', 'src/engines/bdd/worker.ts', 'src/engines/bdd/isolate.ts', ...EXTRA_SOURCE_FILES]) expect(list, p).toContain(p);
    expect(list).not.toContain(BUILD_ID_FILE);
  });

  it('is a sha-256 and changes with any edit, rename, addition or removal', () => {
    const base = [f('src/a.ts', 'one'), f('src/b.ts', 'two')];
    const h = sourceHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash([f('src/a.ts', 'one!'), f('src/b.ts', 'two')])).not.toBe(h); // an edit
    expect(sourceHash([f('src/a2.ts', 'one'), f('src/b.ts', 'two')])).not.toBe(h); // a rename
    expect(sourceHash([...base, f('src/c.ts', '')])).not.toBe(h); // an added (even empty) file
    expect(sourceHash([base[0]!])).not.toBe(h); // a removed file
    expect(sourceHash([f('src/a.ts', 'two'), f('src/b.ts', 'one')])).not.toBe(h); // contents swapped between files
  });

  it('does not depend on the order the files are listed in, or on line endings', () => {
    const a = [f('x.ts', 'l1\nl2\n'), f('y.ts', 'z')];
    expect(sourceHash([...a].reverse())).toBe(sourceHash(a));
    expect(sourceHash([f('x.ts', 'l1\r\nl2\r\n'), f('y.ts', 'z')])).toBe(sourceHash(a));
    expect(sourceHash([f('x.ts', 'l1\rl2\n'), f('y.ts', 'z')])).not.toBe(sourceHash(a)); // a lone CR is not a line ending here
  });

  it('a path and a content cannot be confused with each other', () => {
    expect(sourceHash([f('a', 'b\n')])).not.toBe(sourceHash([f('a\nb', '')]));
  });

  it('a record of a run names the build', async () => {
    const { analyzeBuiltin } = await import('../../src/engines/bdd/analyze.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { ORACLE_MODELS } = await import('../oracle/models.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'sneed-engid-'));
    try {
      const out = await analyzeBuiltin(JSON.stringify(ORACLE_MODELS['pra-or']), { runsDir: dir });
      if (out.kind !== 'ran') throw new Error('not run');
      expect(out.record.engine.sha256).toBe(BDD_SOURCE_SHA256);
      expect(JSON.parse(readFileSync(path.join(out.runDir, 'results.json'), 'utf8')).engine.sha256).toBe(BDD_SOURCE_SHA256); // and so does the file
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
