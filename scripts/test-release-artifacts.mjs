import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectTarGzip, runCommand, verifyReleaseDirectory } from './release-lib.mjs';
import {
  createArtifactTestEnvironment,
  parseArtifactTestArguments,
} from './dev-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const extensionDirectory = path.join(repositoryRoot, 'packages', 'extension');
const releaseDirectory = path.join(repositoryRoot, 'artifacts', 'release-1.0.0');
const releaseVsixPath = path.join(releaseDirectory, 'vscode-mcp-extension-1.0.0.vsix');
const serverArchivePath = path.join(releaseDirectory, 'vscode-mcp-server-1.0.0.tar.gz');
const options = parseArtifactTestArguments(process.argv.slice(2));
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'vscode-mcp-artifact-test-'),
);
const runtimeDirectory = await mkdtemp('/tmp/vmcp-artifact-runtime-');

try {
  await chmod(runtimeDirectory, 0o700);
  await clearExtensionTestCaches();
  let vsixPath;
  let serverPath;
  if (options.mode === 'release') {
    await verifyReleaseDirectory(releaseDirectory);
    const serverRoot = await extractServerArchive(serverArchivePath, temporaryRoot);
    vsixPath = releaseVsixPath;
    serverPath = path.join(serverRoot, 'cli.mjs');
  } else {
    await Promise.all([access(options.vsixPath), access(options.serverPath)]);
    vsixPath = options.vsixPath;
    serverPath = options.serverPath;
  }
  const harness = path.join(temporaryRoot, 'artifact-test-harness');
  await mkdir(harness);
  await writeFile(
    path.join(harness, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vscode-mcp-artifact-test-harness',
        displayName: 'VS Code MCP artifact test harness',
        publisher: 'vscode-mcp-tests',
        version: '1.0.0',
        private: true,
        engines: { vscode: '^1.101.0' },
        extensionKind: ['workspace'],
        activationEvents: ['*'],
        main: './extension.js',
      },
      undefined,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(harness, 'extension.js'),
    "'use strict';\nexports.activate = () => undefined;\nexports.deactivate = () => undefined;\n",
  );

  await runCommand('pnpm', ['run', 'compile-tests'], {
    cwd: extensionDirectory,
  });
  await runCommand(
    'pnpm',
    ['exec', 'vscode-test', '--config', '.vscode-test-artifact.mjs'],
    {
      cwd: extensionDirectory,
      env: createArtifactTestEnvironment(process.env, {
        harnessPath: harness,
        runtimeDirectory,
        serverPath,
        vsixPath,
      }),
    },
  );
} finally {
  await Promise.all([
    rm(temporaryRoot, { force: true, recursive: true }),
    rm(runtimeDirectory, { force: true, recursive: true }),
    clearExtensionTestCaches(),
  ]);
}

async function clearExtensionTestCaches() {
  await Promise.all([
    rm(path.join(extensionDirectory, 'out'), { force: true, recursive: true }),
    rm(path.join(extensionDirectory, '.vscode-test'), {
      force: true,
      recursive: true,
    }),
  ]);
}

async function extractServerArchive(archivePath, destination) {
  const entries = inspectTarGzip(await readFile(archivePath));
  for (const entry of entries) {
    const output = path.join(destination, entry.name);
    if (entry.type === '5') {
      await mkdir(output, { recursive: true, mode: entry.mode });
      continue;
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, entry.contents, { mode: entry.mode });
    await chmod(output, entry.mode);
  }
  return path.join(destination, 'vscode-mcp-server');
}
