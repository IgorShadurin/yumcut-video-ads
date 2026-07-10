import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    outDir: '../../playground-dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
