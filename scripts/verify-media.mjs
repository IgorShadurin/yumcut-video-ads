import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile(resolve('test/fixtures/manifest.json'), 'utf8'));
const expected = { ...manifest.derived, ...manifest.generated };
const locations = [
  'test/fixtures/media',
  'demos/vanilla/public/media',
  'demos/react-vite/public/media',
  'demos/nextjs/public/media',
];

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

for (const location of locations) {
  for (const [name, checksum] of Object.entries(expected)) {
    const path = resolve(location, name);
    const details = await stat(path).catch(() => undefined);
    if (!details?.isFile()) throw new Error(`Missing publishable demo media: ${path}`);
    const actual = await sha256(path);
    if (actual !== checksum) {
      throw new Error(`Checksum mismatch for ${path}: expected ${checksum}, received ${actual}`);
    }
  }
}

const downloadedSource = resolve('test/fixtures/downloads/BigBuckBunny_320x180.mp4');
const sourceDetails = await stat(downloadedSource).catch(() => undefined);
if (sourceDetails?.isFile()) {
  const actual = await sha256(downloadedSource);
  if (actual !== manifest.source.sha256) {
    throw new Error(`Downloaded source checksum mismatch: expected ${manifest.source.sha256}, received ${actual}`);
  }
}

console.log(`Verified ${Object.keys(expected).length} media files in ${locations.length} publishable locations.`);
