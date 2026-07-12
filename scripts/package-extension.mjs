import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { normalizeZipFile } from './release-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const extensionDirectory = path.join(repositoryRoot, 'packages', 'extension');
const serverDirectory = path.join(repositoryRoot, 'packages', 'server');
const stagedServerDirectory = path.join(extensionDirectory, 'server');
const artifactsDirectory = path.join(repositoryRoot, 'artifacts');
const extensionManifest = JSON.parse(
  await readFile(path.join(extensionDirectory, 'package.json'), 'utf8'),
);
const requestedOutput = parseOutputArgument(process.argv.slice(2));
const artifactPath =
  requestedOutput ??
  path.join(
    artifactsDirectory,
    `vscode-mcp-extension-${String(extensionManifest.version)}.vsix`,
  );

const stagedFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'PRIVACY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
];

try {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await rm(path.join(extensionDirectory, 'dist'), { force: true, recursive: true });

  for (const file of stagedFiles) {
    await copyFile(
      path.join(repositoryRoot, file),
      path.join(extensionDirectory, file),
    );
  }

  await runPnpm(['run', 'build:production'], serverDirectory);
  await stageBundledServer();
  await runPnpm(['run', 'build:production']);
  await runPnpm([
    'exec',
    'vsce',
    'package',
    '--no-dependencies',
    '--out',
    artifactPath,
  ]);
  await normalizeZipFile(artifactPath);
} finally {
  await Promise.all([
    ...stagedFiles.map((file) =>
      rm(path.join(extensionDirectory, file), { force: true }),
    ),
    rm(stagedServerDirectory, { force: true, recursive: true }),
  ]);
}

async function stageBundledServer() {
  const cli = await readFile(path.join(serverDirectory, 'dist', 'cli.mjs'));
  const serverManifest = JSON.parse(
    await readFile(path.join(serverDirectory, 'package.json'), 'utf8'),
  );
  if (
    serverManifest.version !== extensionManifest.version ||
    typeof serverManifest.engines?.node !== 'string'
  ) {
    throw new Error('Bundled server metadata does not match the extension.');
  }
  await rm(stagedServerDirectory, { force: true, recursive: true });
  await mkdir(stagedServerDirectory, { mode: 0o700 });
  await writeFile(path.join(stagedServerDirectory, 'cli.mjs'), cli, { mode: 0o600 });
  await writeFile(
    path.join(stagedServerDirectory, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        productVersion: String(extensionManifest.version),
        nodeEngine: serverManifest.engines.node,
        cli: {
          file: 'cli.mjs',
          sha256: createHash('sha256').update(cli).digest('hex'),
        },
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function parseOutputArgument(arguments_) {
  if (arguments_.length === 0) {
    return undefined;
  }
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== '--out' ||
    arguments_[1].length === 0
  ) {
    throw new Error('Usage: node scripts/package-extension.mjs [--out <file.vsix>]');
  }
  return path.resolve(arguments_[1]);
}

function runPnpm(arguments_, cwd = extensionDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', arguments_, {
      cwd,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `pnpm ${arguments_.join(' ')} failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}
