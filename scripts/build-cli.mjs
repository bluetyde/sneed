// Builds the headless runner to plain JavaScript for programs that start it with `node` (the SEED adapter):
//   npm run build:cli    ->  dist/node/cli/headless.js  (plus dist/schema, which the validator reads relative to its own file)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
rmSync(path.join(root, 'dist', 'node'), { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(root, 'tsconfig.cli.json')], { stdio: 'inherit', cwd: root });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
cpSync(path.join(root, 'schema'), path.join(root, 'dist', 'schema'), { recursive: true });
const entry = path.join(root, 'dist', 'node', 'cli', 'headless.js');
if (!existsSync(entry)) {
  console.error('build did not produce', entry);
  process.exit(1);
}
console.log('built', entry);
