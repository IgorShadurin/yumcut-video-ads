import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const demos = ['demos/vanilla', 'demos/react-vite', 'demos/nextjs'];
const mode = process.argv[2];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = resolve('.');

if (!['install', 'build', 'test'].includes(mode)) {
  console.error('Usage: node scripts/run-demo-tasks.mjs <install|build|test>');
  process.exit(1);
}

function run(arguments_, cwd = root) {
  execFileSync(npm, arguments_, { cwd, stdio: 'inherit' });
}

if (mode !== 'install') run(['run', 'build']);

for (const demo of demos) {
  const directory = resolve(demo);
  run(['ci'], directory);
  if (mode === 'build') run(['run', 'build'], directory);
}

if (mode === 'test') {
  run(['exec', '--', 'playwright', 'test', '--config', 'playwright.demos.config.ts']);
}
