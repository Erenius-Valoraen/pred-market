import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  // web3.js references Node's `global`; alias it to the browser's globalThis.
  define: { global: 'globalThis' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
    // The UI imports the same LMSR module the tests cover (../src/lmsr.js).
    fs: { allow: [path.resolve(import.meta.dirname, '..')] },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
