import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isVersionInRange } from './dev-lib.mjs';
import { captureCommand } from './process-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const failures = [];

check(
  'platform',
  process.platform === 'darwin' || process.platform === 'linux',
  `${process.platform} (1.0 development supports macOS and Linux)`,
);
check(
  'Node.js',
  isVersionInRange(process.versions.node, '22.13.0', 23),
  `${process.versions.node} (required: >=22.13.0 <23)`,
);

const pnpmVersion = await captureCommand('pnpm', ['--version']);
check(
  'pnpm',
  pnpmVersion !== undefined && isVersionInRange(pnpmVersion, '10.24.0', 11),
  `${pnpmVersion ?? 'not found'} (required: >=10.24.0 <11)`,
);

for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  try {
    await access(path.join(repositoryRoot, file));
    process.stdout.write(`ok  ${file}\n`);
  } catch {
    failures.push(file);
    process.stderr.write(`ERR ${file}: missing\n`);
  }
}

const manifest = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
check(
  'packageManager',
  manifest.packageManager === 'pnpm@10.24.0',
  String(manifest.packageManager),
);

const codeCommand = await findCodeCommand();
if (codeCommand) {
  process.stdout.write(`ok  VS Code CLI: ${codeCommand}\n`);
} else {
  process.stdout.write(
    'warn VS Code CLI: not found (development works; --install needs the code CLI)\n',
  );
}

if (failures.length > 0) {
  process.stderr.write(`Doctor found ${String(failures.length)} blocking issue(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('vscode-mcp doctor passed.\n');
}

export async function findCodeCommand() {
  const candidates = [
    process.env.VSCODE_CLI,
    'code',
    process.platform === 'darwin'
      ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
      : undefined,
    'code-insiders',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    if ((await captureCommand(candidate, ['--version'])) !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function check(name, passed, detail) {
  if (passed) {
    process.stdout.write(`ok  ${name}: ${detail}\n`);
    return;
  }
  failures.push(name);
  process.stderr.write(`ERR ${name}: ${detail}\n`);
}
