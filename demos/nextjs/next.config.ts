import type { NextConfig } from 'next';
import path from 'node:path';

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

const basePath = normalizeBasePath(process.env.YUMCUT_DEMO_BASE_PATH);
const staticExport = process.env.YUMCUT_STATIC_EXPORT === '1';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath } : {}),
  ...(staticExport ? { output: 'export' as const, trailingSlash: true } : {}),
  env: {
    NEXT_PUBLIC_YUMCUT_BASE_PATH: basePath,
  },
  transpilePackages: ['yumcut-video-ads'],
  // Keep the linked repository package inside Turbopack's explicit file graph.
  turbopack: {
    root: path.resolve(process.cwd(), '../..'),
  },
};

export default nextConfig;
