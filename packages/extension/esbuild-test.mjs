import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import * as esbuild from 'esbuild';

const entryName = process.argv[2];
if (entryName !== 'scanner-spike') {
  throw new Error('The test bundle entry is not allowed.');
}

await mkdir('out', { recursive: true });
await esbuild.build({
  entryPoints: [`src/test/${entryName}.ts`],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: `out/${entryName}.js`,
  external: ['vscode'],
  sourcemap: 'inline',
  legalComments: 'external',
});
