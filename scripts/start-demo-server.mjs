import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

const DEMOS = {
  vanilla: { directory: 'demos/vanilla', serverScript: 'preview' },
  react: { directory: 'demos/react-vite', serverScript: 'preview' },
  next: { directory: 'demos/nextjs', serverScript: 'start' },
};

const [demoName, rawPort] = process.argv.slice(2);
const demo = DEMOS[demoName];
const port = Number(rawPort);

if (!demo || !Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error('Usage: node scripts/start-demo-server.mjs <vanilla|react|next> <port>');
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const directory = resolve(demo.directory);

execFileSync(npm, ['--prefix', directory, 'run', 'build'], {
  stdio: 'inherit',
});

const serverArguments = demoName === 'next'
  ? ['--prefix', directory, 'run', demo.serverScript, '--', '--hostname', '127.0.0.1', '--port', String(port)]
  : ['--prefix', directory, 'run', demo.serverScript, '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];

const server = spawn(npm, serverArguments, { stdio: 'inherit' });
let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
  const forceExit = setTimeout(() => process.exit(0), 2_000);
  forceExit.unref();
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
server.once('error', (error) => {
  console.error(error);
  process.exit(1);
});
server.once('exit', (code, signal) => {
  if (stopping || signal) process.exit(0);
  process.exit(code ?? 1);
});
