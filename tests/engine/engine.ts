// Which engine the engine tests run against. By default the development build; set SNEED_RUNTIME_STATE
// (and SNEED_RUNTIME_ROOT) to run the same suite against an installed runtime from the recipe.
import path from 'node:path';
import { DEFAULT_ENGINE, type EngineConfig } from '../../src/core/engine.js';
import { resolveEngine } from '../../src/runtime/install.js';

export const FROM_RUNTIME = Boolean(process.env.SNEED_RUNTIME_STATE);

export const ENGINE: EngineConfig = FROM_RUNTIME
  ? resolveEngine({ distro: process.env.SNEED_WSL_DISTRO ?? 'Ubuntu', linuxRoot: process.env.SNEED_RUNTIME_ROOT ?? '/root/sneed-runtime', stateDir: path.resolve(process.env.SNEED_RUNTIME_STATE!) })
  : DEFAULT_ENGINE;
