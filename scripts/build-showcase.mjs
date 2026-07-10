import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'showcase-dist');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, cwd = root, extraEnvironment = {}) {
  execFileSync(npm, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    stdio: 'inherit',
  });
}

function installAndBuild(relativeDirectory, environment) {
  const directory = resolve(root, relativeDirectory);
  run(['ci', '--include=dev', '--ignore-scripts'], directory);
  run(['run', 'build'], directory, environment);
}

run(['run', 'build']);

installAndBuild('demos/vanilla', {
  YUMCUT_DEMO_BASE_PATH: '/vanilla/',
  YUMCUT_SOURCE_MAPS: '0',
});
installAndBuild('demos/react-vite', {
  YUMCUT_DEMO_BASE_PATH: '/react/',
  YUMCUT_SOURCE_MAPS: '0',
});
installAndBuild('demos/nextjs', {
  YUMCUT_DEMO_BASE_PATH: '/nextjs',
  YUMCUT_STATIC_EXPORT: '1',
});

rmSync(output, { force: true, recursive: true });
mkdirSync(output, { recursive: true });

cpSync(resolve(root, 'deploy/index.html'), resolve(output, 'index.html'));
cpSync(resolve(root, 'demos/nextjs/out'), resolve(output, 'nextjs'), { recursive: true });
cpSync(resolve(root, 'demos/react-vite/dist'), resolve(output, 'react'), { recursive: true });
cpSync(resolve(root, 'demos/vanilla/dist'), resolve(output, 'vanilla'), { recursive: true });
cpSync(resolve(root, 'demos/vanilla/public/media'), resolve(output, 'media'), { recursive: true });
cpSync(resolve(root, 'deploy/media-index.html'), resolve(output, 'media/index.html'));

console.log(`Showcase assembled at ${output}`);
