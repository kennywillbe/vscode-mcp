import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createMcpConfig, parseSetupArguments } from './dev-lib.mjs';
import { runCommand } from './process-lib.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseSetupArguments(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    'Usage: pnpm setup:local [--install]\n\nBuild local artifacts and configuration. --install also installs the VSIX.\n',
  );
  process.exit(0);
}

await runCommand(process.execPath, ['scripts/doctor.mjs'], { cwd: repositoryRoot });

const localDirectory = path.join(repositoryRoot, 'artifacts', 'local');
const vsixPath = path.join(localDirectory, 'vscode-mcp-extension-1.0.0.vsix');
const serverPath = path.join(repositoryRoot, 'packages', 'server', 'dist', 'cli.mjs');
const configPath = path.join(localDirectory, 'mcp-config.json');

await mkdir(localDirectory, { recursive: true });
await runCommand(
  'pnpm',
  ['--filter', '@vscode-mcp/server', 'run', 'build:production'],
  {
    cwd: repositoryRoot,
  },
);
await runCommand(
  process.execPath,
  ['scripts/package-extension.mjs', '--out', vsixPath],
  { cwd: repositoryRoot },
);
await writeFile(
  configPath,
  `${JSON.stringify(createMcpConfig(process.execPath, serverPath), undefined, 2)}\n`,
  { mode: 0o600 },
);

if (options.install) {
  const codeCommand = await resolveCodeCommand();
  if (!codeCommand) {
    throw new Error(
      'VS Code CLI was not found. Run “Shell Command: Install code command in PATH” in VS Code, then retry.',
    );
  }
  await runCommand(codeCommand, ['--install-extension', vsixPath, '--force']);
}

process.stdout.write(
  `\nLocal setup is ready:\nVSIX: ${vsixPath}\nServer: ${serverPath}\nMCP config: ${configPath}\n`,
);
process.stdout.write(
  options.install
    ? 'VSIX installed. Open a trusted local workspace and run “VS Code MCP: Enable for This Workspace”.\n'
    : 'Run “pnpm setup:local -- --install” to install the VSIX.\n',
);

async function resolveCodeCommand() {
  const candidates = [
    process.env.VSCODE_CLI,
    'code',
    process.platform === 'darwin'
      ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
      : undefined,
    'code-insiders',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    try {
      await runCommand(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next documented VS Code CLI location.
    }
  }
  return undefined;
}
