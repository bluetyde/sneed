// Standalone front end for the SCRAM runtime recipe. SEED's installer consumes the same recipe; this is the app's own path.
//   npm run runtime -- install | status | verify | recover | rollback | engine
// Environment: SNEED_WSL_DISTRO (default Ubuntu), SNEED_RUNTIME_ROOT (Linux dir, default /root/sneed-runtime),
//              SNEED_RUNTIME_STATE (Windows dir, default ~/.sneed/runtime).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRuntimeEnv, install, recover, resolveEngine, rollback, status, verifyActive } from '../src/runtime/install.js';
import { loadRecipe } from '../src/runtime/recipe.js';

const env = defaultRuntimeEnv();
const recipeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime');

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'install') {
    const loaded = loadRecipe(recipeDir);
    const r = loaded.recipe;
    console.log(`SCRAM ${r.artifact.version} (recipe r${r.artifact.recipe_revision}), ${r.license.spdx}`);
    console.log(`download about ${Math.round(r.sizes.download_bytes / 1e6)} MB, about ${(r.sizes.expanded_bytes / 1e9).toFixed(1)} GB on disk, into ${env.linuxRoot} in ${env.distro}`);
    console.log(`source ${r.trust.source_url} @ ${r.trust.source_commit.slice(0, 12)}; toolchain lock sha256 ${r.trust.toolchain_lock_sha256.slice(0, 12)}`);
    console.log(`trust: ${r.trust.authenticity}`);
    const abort = new AbortController();
    process.once('SIGINT', () => {
      console.log('\ncancelling: stopping only the processes this install started...');
      abort.abort();
    });
    let last = '';
    const { record, manifest } = await install(env, loaded, {
      signal: abort.signal,
      onState: (s) => {
        const line = `${s.state}${s.step ? ' / ' + s.step : ''}`;
        if (line !== last) console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
        last = line;
      },
    });
    if (record.state === 'ready' && manifest) {
      console.log(`ready: ${manifest.binary.version_text.split('\n')[0]}, binary sha256 ${manifest.binary.sha256.slice(0, 16)}, ${manifest.smoke.cases.length} smoke checks passed`);
      return 0;
    }
    console.error(`${record.state}: ${record.reasons.join(', ')}  (logs: ${path.join(env.stateDir, 'scram', 'installs', record.id)})`);
    return record.state === 'cancelled' ? 130 : 1;
  }
  if (cmd === 'status') {
    const s = status(env);
    console.log(JSON.stringify({ active: s.active ? { install_id: s.active.install_id, prefix: s.active.prefix, activated_at: s.active.activated_at, previous: s.active.previous } : null, installs: s.installs.map((i) => ({ id: i.id, state: i.state, reasons: i.reasons })), lockHeld: s.lockHeld, lockStale: s.lockStale }, null, 2));
    return 0;
  }
  if (cmd === 'verify') {
    const issues = await verifyActive(env);
    console.log(issues.length ? issues.map((i) => `${i.code}: ${i.message}`).join('\n') : 'active runtime verified');
    return issues.length ? 1 : 0;
  }
  if (cmd === 'recover') {
    const fixed = await recover(env);
    console.log(fixed.length ? fixed.map((r) => `${r.id}: ${r.state}`).join('\n') : 'nothing to recover');
    return 0;
  }
  if (cmd === 'rollback') {
    const p = await rollback(env);
    console.log(`rolled back to ${p.prefix} (previous: ${p.previous})`);
    return 0;
  }
  if (cmd === 'engine') {
    console.log(JSON.stringify(resolveEngine(env), null, 2));
    return 0;
  }
  console.error('usage: npm run runtime -- install | status | verify | recover | rollback | engine');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
