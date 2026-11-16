/**
 * ClawView build. `npm run build` writes the console to ../ui, which the node's API server
 * serves (API.md section 2.3). `npm run dev` proxies /api to a running node: set
 * CLAWNET_API to its API address, for example http://127.0.0.1:47480.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.CLAWNET_API ?? 'http://127.0.0.1:47480';

export default defineConfig({
  plugins: [react()],
  // Inline (empty) PostCSS config: stops Vite from picking up a config in a parent folder.
  css: { postcss: {} },
  build: {
    outDir: fileURLToPath(new URL('../ui', import.meta.url)),
    emptyOutDir: true,
    // The node's CSP allows scripts from 'self' only; the polyfill would be an inline script.
    modulePreload: { polyfill: false },
    sourcemap: false,
    // three's renderer core is about 550 kB minified and cannot be split further; it is a
    // separate chunk loaded only with the map, so the shell stays small.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // three is large and only the map needs it; it gets its own long-lived chunk.
        manualChunks: (id) => (id.includes('node_modules/three/') ? 'three' : undefined),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        // The node refuses a foreign Origin (API.md 2.2); behind this proxy the page is same-origin in spirit.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
});
