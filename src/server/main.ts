// Starts the SNEED server: the API plus the built web app, bound to this computer only.
//   npm run server            (environment: SNEED_PORT, SNEED_PROJECT_DIR, SNEED_RUNS_DIR, SNEED_ALLOWED_ORIGINS)
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.SNEED_PORT ?? 5205);
const projectDir = process.env.SNEED_PROJECT_DIR ?? path.join(homedir(), '.sneed', 'models');
const runsDir = process.env.SNEED_RUNS_DIR ?? path.join(homedir(), '.sneed', 'runs');
const allowedOrigins = (process.env.SNEED_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

startServer({ projectDir, runsDir, staticDir: path.join(root, 'dist', 'web'), allowedOrigins }, port).then(
  (s) => {
    console.log(`SNEED server on ${s.url}  (models in ${projectDir}, runs in ${runsDir})`);
    const stop = (): void => void s.close().then(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  },
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
