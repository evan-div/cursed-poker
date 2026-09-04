import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@cursed/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Fail loudly rather than sliding to 5174, which the server's CORS origin
    // would not match — the page would load and then silently never connect.
    strictPort: true,
  },
});
