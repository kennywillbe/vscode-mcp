import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

await mkdir('dist', { recursive: true });

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'external',
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  process.stderr.write('vscode-mcp extension build is watching for changes.\n');
} else {
  await esbuild.build(options);
}
