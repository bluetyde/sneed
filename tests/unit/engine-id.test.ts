import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILD_ID_FILE, EXTRA_SOURCE_FILES, readEngineSources, relativeImports, renderBuildId, sourceHash, type SourceFile } from '../../scripts/lib/engine-id.js';
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

  it('covers the solver, the importance code, the result checks, the product-order bound, the validator, the exporter version, the report parser and the schema', () => {
    const list = [...BDD_SOURCE_FILES];
    for (const p of [
      'src/engines/bdd/bdd.ts', 'src/engines/bdd/solve.ts', 'src/engines/bdd/analyze.ts', 'src/engines/bdd/importance.ts', 'src/engines/bdd/worker.ts', 'src/engines/bdd/isolate.ts', 'src/engines/bdd/importance-worker.ts',
      'src/core/result.ts', 'src/core/canonical.ts', 'src/core/bounds.ts', 'src/core/validate.ts', 'src/core/report.ts', 'src/core/export.ts',
      ...EXTRA_SOURCE_FILES,
    ]) expect(list, p).toContain(p);
    expect(list).toContain('schema/model.schema.json');
    expect(list).not.toContain(BUILD_ID_FILE);
  });

  it('is closed: everything a hashed file imports at run time is hashed too, and a type-only import is not followed', () => {
    const files = readEngineSources(ROOT);
    const have = new Set(files.map((x) => x.path));
    for (const file of files.filter((x) => x.path.endsWith('.ts'))) {
      for (const spec of relativeImports(file.content)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec)).replace(/\.js$/, '.ts');
        if (target === BUILD_ID_FILE) continue;
        expect(have.has(target), `${file.path} imports ${spec}, which is not hashed`).toBe(true);
      }
    }
    // the SCRAM runtime and the process runner are reached only through `import type`: they cannot change what the built-in engine computes
    expect(have.has('src/core/analyze.ts')).toBe(false);
    expect(have.has('src/core/engine.ts')).toBe(false);
    expect(have.has('src/runtime/install.ts')).toBe(false);
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
    const { mkdtempSync: mk, rmSync: rm } = await import('node:fs');
    const { ORACLE_MODELS } = await import('../oracle/models.js');
    const dir = mk(path.join(tmpdir(), 'sneed-engid-'));
    try {
      const out = await analyzeBuiltin(JSON.stringify(ORACLE_MODELS['pra-or']), { runsDir: dir });
      if (out.kind !== 'ran') throw new Error('not run');
      expect(out.record.engine.sha256).toBe(BDD_SOURCE_SHA256);
      expect(JSON.parse(readFileSync(path.join(out.runDir, 'results.json'), 'utf8')).engine.sha256).toBe(BDD_SOURCE_SHA256); // and so does the file
    } finally {
      rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('which imports are followed', () => {
  it('follows static, re-export, side-effect, dynamic and mixed imports, and skips type-only ones and packages', () => {
    const text = [
      "import { a } from './a.js';",
      "import type { T } from './t.js';",
      "export type { U } from './u.js';",
      "export { b } from '../b.js';",
      "import './side.js';",
      "const m = await import('./dyn.js');",
      "import { type V, c } from './mixed.js';",
      "import fs from 'node:fs';",
      "import pkg from 'some-package';",
      "import type {\n  Multi,\n} from './multi.js';",
    ].join('\n');
    expect(relativeImports(text).sort()).toEqual(['../b.js', './a.js', './dyn.js', './mixed.js', './side.js']);
  });
});

describe('reading the sources of a project', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>): string => {
    const d = mkdtempSync(path.join(tmpdir(), 'sneed-engid-tree-'));
    dirs.push(d);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
      writeFileSync(path.join(d, p), c);
    }
    return d;
  };

  it('collects the engine folder and what it reaches, through any depth, cycles and the generated file', () => {
    const d = tree({
      'src/engines/bdd/x.ts': "import { h } from '../../core/h.js';\nimport { id } from './build-id.js';\nimport type { T } from '../../core/typeonly.js';",
      'src/engines/bdd/build-id.ts': "export const id = 1;",
      'src/core/h.ts': "import { i } from '../util/i.js';",
      'src/util/i.ts': "import { h } from '../core/h.js';\nexport const i = 1;", // a cycle
      'src/core/typeonly.ts': 'export type T = 1;',
      'src/core/unrelated.ts': 'export const u = 1;',
      'schema/model.schema.json': '{}',
    });
    expect(readEngineSources(d).map((x) => x.path).sort()).toEqual(['schema/model.schema.json', 'src/core/h.ts', 'src/engines/bdd/x.ts', 'src/util/i.ts']);
  });

  it('does not read a file outside the project through a ../ import, and ignores an import of something that does not exist', () => {
    const d = tree({
      'outside.ts': 'export const o = 1;', // next to the project folder, reachable by ../../../outside.js from the engine folder
      'project/src/engines/bdd/x.ts': "import { o } from '../../../outside.js';
import { n } from './nothing.js';",
      'project/schema/model.schema.json': '{}',
    });
    expect(existsSync(path.join(d, 'outside.ts'))).toBe(true);
    expect(readEngineSources(path.join(d, 'project')).map((x) => x.path).sort()).toEqual(['schema/model.schema.json', 'src/engines/bdd/x.ts']);
  });
});
