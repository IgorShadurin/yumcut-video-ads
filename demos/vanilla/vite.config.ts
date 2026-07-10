import { defineConfig } from 'vite';

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig({
  // Coolify builds the demo below /vanilla/. Local development keeps using /.
  base: normalizeBasePath(process.env.YUMCUT_DEMO_BASE_PATH),
  server: {
    host: '127.0.0.1',
    port: 5180,
  },
  preview: {
    host: '127.0.0.1',
    port: 4180,
  },
  build: {
    sourcemap: process.env.YUMCUT_SOURCE_MAPS !== '0',
  },
});
