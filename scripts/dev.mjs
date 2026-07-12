import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCommand } from './process-lib.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.stdout.write('vscode-mcp dev starting\n');
await runCommand('pnpm', ['run', 'build'], { cwd: repositoryRoot });

const watcher = spawn(
  'pnpm',
  [
    'exec',
    'concurrently',
    '-k',
    '-n',
    'protocol,extension,server',
    'pnpm --filter @vscode-mcp/protocol run watch',
    'pnpm --filter vscode-mcp run watch',
    'pnpm --filter @vscode-mcp/server run watch',
  ],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

process.stdout.write('vscode-mcp dev watchers ready\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => watcher.kill(signal));
}

watcher.once('error', (error) => {
  throw error;
});
watcher.once('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 0;
  } else {
    process.exitCode = code ?? 1;
  }
});
