import { mkdir } from 'node:fs/promises';
import process from 'node:process';

import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

await mkdir('dist', { recursive: true });

const options = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/cli.mjs',
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'external',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  process.stderr.write('vscode-mcp server build is watching for changes.\n');
} else {
  await esbuild.build(options);
}
