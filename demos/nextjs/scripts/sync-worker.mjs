import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../node_modules/yumcut-video-ads/dist/render-worker.js', import.meta.url),
);
const outputDirectory = fileURLToPath(new URL('../public/vendor/', import.meta.url));
const destination = fileURLToPath(
  new URL('../public/vendor/yumcut-render-worker.js', import.meta.url),
);

await mkdir(outputDirectory, { recursive: true });
await copyFile(source, destination);
console.log('Synced the YumCut render worker into public/vendor.');
