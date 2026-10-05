// Which engine the engine tests run against. By default the installed runtime from the recipe (the same one the app
// uses); set SNEED_DEV_ENGINE=1 to run the suite against the developer's own spike build instead.
import { DEV_ENGINE, type EngineConfig } from '../../src/core/engine.js';
import { defaultRuntimeEnv, resolveEngine } from '../../src/runtime/resolve.js';

export const FROM_RUNTIME = !process.env.SNEED_DEV_ENGINE;

export const ENGINE: EngineConfig = FROM_RUNTIME ? resolveEngine(defaultRuntimeEnv()) : DEV_ENGINE;
