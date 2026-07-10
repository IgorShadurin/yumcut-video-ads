import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: { compilerOptions: { declarationMap: true } },
    sourcemap: true,
    splitting: true,
    clean: true,
    treeshake: true,
    minify: true,
    noExternal: ['mediabunny'],
    banner: {
      js: '/*! Includes Mediabunny 1.50.8 (MPL-2.0); see THIRD_PARTY_NOTICES.md. */',
    },
    outDir: 'dist',
  },
  {
    entry: { 'render-worker': 'src/render-worker.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    splitting: false,
    clean: false,
    treeshake: true,
    minify: true,
    noExternal: ['mediabunny'],
    banner: {
      js: '/*! Includes Mediabunny 1.50.8 (MPL-2.0); see THIRD_PARTY_NOTICES.md. */',
    },
    outDir: 'dist',
  },
]);
