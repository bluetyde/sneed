// Writes oracles/seed/{entries,models} from the sources (scripts/lib/seed-oracles.ts). Run: npm run gen:seed-oracles
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSeedOracles } from './lib/seed-oracles.js';

const base = path.resolve(import.meta.dirname, '..', 'oracles', 'seed');
const files = buildSeedOracles();
for (const dir of ['entries', 'models']) {
  mkdirSync(path.join(base, dir), { recursive: true });
  for (const f of readdirSync(path.join(base, dir))) rmSync(path.join(base, dir, f)); // stale files must not survive a rename
}
for (const f of files) writeFileSync(path.join(base, f.path), f.text, 'utf8');
console.log(`wrote ${files.length} files under oracles/seed (${files.filter((f) => f.path.startsWith('entries/')).length} entries)`);
