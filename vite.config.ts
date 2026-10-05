import { defineConfig } from 'vite';

// SNEED_PORT is the API server (default 5205); SNEED_WEB_PORT is this dev server (default 5206).
const api = `http://127.0.0.1:${Number(process.env.SNEED_PORT ?? 5205)}`;

export default defineConfig({
  root: 'src/web',
  base: '/',
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.SNEED_WEB_PORT ?? 5206),
    strictPort: true,
    // the API checks Host and Origin; changeOrigin gives it the Host it expects
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
});
