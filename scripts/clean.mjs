import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputs = ['dist', 'coverage', '.vitest-output', 'benchmark-results'];

await Promise.all(outputs.map((output) => rm(resolve(output), {
  force: true,
  recursive: true,
})));
