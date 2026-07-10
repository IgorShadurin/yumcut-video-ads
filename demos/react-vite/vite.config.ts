import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig({
  // Coolify builds the demo below /react/. Local development keeps using /.
  base: normalizeBasePath(process.env.YUMCUT_DEMO_BASE_PATH),
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: process.env.YUMCUT_SOURCE_MAPS !== '0',
  },
});
