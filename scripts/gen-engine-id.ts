// Writes src/engines/bdd/build-id.ts: the identity (source hash) of the built-in engine. Run after any change to the files it lists:
//   npm run gen:engine-id
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD_ID_FILE, readEngineSources, renderBuildId } from './lib/engine-id.js';

const root = path.resolve(import.meta.dirname, '..');
const text = renderBuildId(readEngineSources(root));
writeFileSync(path.join(root, BUILD_ID_FILE), text, { encoding: 'utf8' });
console.log(`wrote ${BUILD_ID_FILE}: ${/BDD_SOURCE_SHA256 = '([0-9a-f]+)'/.exec(text)![1]}`);
